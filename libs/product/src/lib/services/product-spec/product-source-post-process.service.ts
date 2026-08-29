import { Injectable } from '@nestjs/common';
import { AiChatService } from '@fittkereso-backend/ai';
import type {
  ProductSpecs,
  ScrapedProductSpec,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { isEmpty, omit, pick } from 'lodash';
import { ProductSpecNormalizationService } from './product-spec-normalization.service';

const DEFAULT_MODEL = 'deepseek-v4-flash';

/**
 * Reasoning is left ON by default because the pass genuinely depends on it:
 * most sources publish a free-text OEM component list, and canonical fields
 * (motorPosition from a Bosch `BDU*` code, seatpostType from "FOX Transfer",
 * tubeless from a `TLE`/`TLR` token, equipment booleans from blank rows) exist
 * only as inferences over that text. It is capped at 'low' rather than left at
 * the provider default: a measured call spent 3052 output tokens on a response
 * whose JSON payload was ~200, nearly all of it internal reasoning
 * (docs/SpecUnificationAnalysis.md §5). Sources with an already-normalized
 * spec table should set `thinking: false` per-source instead.
 */
const DEFAULT_EFFORT = 'low';

/**
 * Safety ceiling, not a tuning knob — sized to clear a fully-populated specs
 * object with room to spare (the ebikes golden sample is 92 fields, ~1.2k
 * output tokens) plus a bounded reasoning trace. Truncation fails JSON parsing
 * and degrades the whole pass to deterministic-only, so this must never bind
 * on a well-behaved call. Raised from 20000 after a source's reasoning trace
 * alone consumed the full previous ceiling (2026-08-28).
 */
const DEFAULT_MAX_TOKENS = 40000;

/** Deterministic, pre-LLM view of a scraped product. */
export interface DeterministicProductData {
  brand: string;
  model: string;
  specs: ProductSpecs;
}

/**
 * What the offer-identity LLM call may confidently contribute — brand/model
 * plus only offer-level spec keys (frameSize, color, etc.). Fields the LLM
 * isn't confident about are omitted rather than guessed.
 */
export interface OfferIdentityContribution {
  brand?: string;
  model?: string;
  specs?: ProductSpecs;
}

/**
 * What the model-spec (product-identity) LLM call may confidently
 * contribute — only non-offer-level spec keys. This call never touches
 * brand/model.
 */
export interface ModelSpecContribution {
  specs?: ProductSpecs;
}

interface RawLlmResponse {
  brand?: string;
  model?: string;
  specs?: ProductSpecs;
}

interface ContributionCallParams {
  systemPrompt: string;
  userMessage: string;
  responseSchema: unknown;
  model?: string;
  thinking?: boolean;
  effort?: string;
  maxTokens?: number;
}

/**
 * Post-processes a source's deterministically-extracted data via two
 * independently-scoped LLM calls, guided by the category's JSON Schema plus
 * one hand-picked "golden sample" product:
 *  - `processOfferIdentity`: cleans the source's raw product title down to
 *    just the model name (stripping brand/marketing/color/gender/category
 *    boilerplate some sources bake into the same field), optionally corrects
 *    brand, and extracts only offer-level spec keys (frameSize,
 *    color, etc.) — values that vary per purchasable listing, not per
 *    product model. Always runs, for every scraped listing, since this
 *    output is inherently page-specific and can never be reused from a
 *    sibling listing of the same product.
 *  - `processModelSpecs`: unifies only the non-offer-level (product-
 *    identity) spec keys — weight, motor power, frame material, etc. This is
 *    the expensive, reasoning-heavy half of the original single call, and
 *    the one callers can skip when a sibling ProductSourceRecord (same
 *    source, different listing) already produced an identical raw spec
 *    table for this half — see ProductDetailsPageScraperService.
 *
 * Both run AFTER SpecExtractionService, not instead of it — the deterministic
 * pass already did unit stripping/number extraction/value remapping; these
 * calls only re-key/re-shape into the canonical field set for sources whose
 * raw labels don't line up with the category's SourceSpecMapping[] entries.
 *
 * Each returns only what the LLM confidently contributed (or `undefined` on
 * any failure) — never a value pre-merged with deterministic data. Merging is
 * ProductSourcePostProcessMergeService's job, so "no LLM contribution" has
 * exactly one shape (`undefined`) regardless of why: disabled, no golden
 * sample, thrown error, or an empty parsed response. Mirrors
 * TranslationService's degrade-on-failure contract: any internal error (LLM
 * call failure, schema validation failure) is caught and never thrown — a
 * failed post-process pass should not fail the whole scrape. The two calls
 * fail independently of one another.
 */
@Injectable()
export class ProductSourcePostProcessService {
  private readonly logger = new CustomLogger(
    ProductSourcePostProcessService.name,
  );

  constructor(
    private readonly aiChat: AiChatService,
    private readonly specNormalizer: ProductSpecNormalizationService,
  ) {}

  /**
   * Always runs, for every listing. `data.specs` is expected to already be
   * restricted to the offer-level subset of the deterministic mapping by the
   * caller (`pick(deterministicSpecs, offerLevelSpecs)`) — this method does
   * not re-filter, it only restricts what it asks the LLM to *output* via
   * the response schema/prompt. No raw spec rows are sent to this call at
   * all — its only inputs are the raw title/model text and the already-
   * mapped offer-level specs; a value that lives only in unmapped raw text
   * (no SourceSpecMapping pointing at it) is out of scope for this call.
   */
  async processOfferIdentity(params: {
    data: Pick<DeterministicProductData, 'brand' | 'model'> & {
      specs: ProductSpecs;
    };
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    offerLevelSpecs: string[];
    model?: string;
    thinking?: boolean;
    effort?: string;
    maxTokens?: number;
  }): Promise<OfferIdentityContribution | undefined> {
    const { data, schema, goldenSample, offerLevelSpecs } = params;

    const response = await this.runContributionCall({
      systemPrompt: this.buildOfferIdentitySystemPrompt(
        schema,
        goldenSample,
        offerLevelSpecs,
      ),
      userMessage: this.buildUserMessage(data),
      responseSchema: this.buildOfferIdentityResponseSchema(
        schema,
        offerLevelSpecs,
      ),
      model: params.model,
      thinking: params.thinking,
      effort: params.effort,
      maxTokens: params.maxTokens,
    });
    if (!response) return undefined;

    const sanitized: OfferIdentityContribution = {
      brand: response.brand?.trim() || undefined,
      model: response.model?.trim() || undefined,
      specs: response.specs
        ? this.specNormalizer.normalize(response.specs, schema)
        : undefined,
    };

    if (this.isEmptyContribution(sanitized)) {
      this.logger.warn(
        'Offer-identity post-process contributed nothing usable after sanitization, degrading to deterministic-only',
      );
      return undefined;
    }

    return sanitized;
  }

  /**
   * The expensive, reasoning-heavy half — unifies only non-offer-level
   * (product-identity) spec keys. `data.specs` is expected to already be
   * restricted to the product-level subset (`omit(deterministicSpecs,
   * offerLevelSpecs)`) by the caller; `offerLevelDeterministicSpecs` is
   * passed separately, purely as read-only prompt context (per
   * buildModelSpecSystemPrompt's own instructions), since it lives outside
   * `data.specs` now. Gets the full rawSpecs for complete context (unlike
   * processOfferIdentity's restricted input), but its response schema never
   * includes brand/model or offer-level keys.
   */
  async processModelSpecs(params: {
    data: DeterministicProductData;
    offerLevelDeterministicSpecs?: ProductSpecs;
    rawSpecs?: ScrapedProductSpec[];
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    offerLevelSpecs: string[];
    model?: string;
    thinking?: boolean;
    effort?: string;
    maxTokens?: number;
  }): Promise<ModelSpecContribution | undefined> {
    const { data, offerLevelDeterministicSpecs, rawSpecs, schema, goldenSample, offerLevelSpecs } =
      params;

    const response = await this.runContributionCall({
      systemPrompt: this.buildModelSpecSystemPrompt(
        schema,
        goldenSample,
        offerLevelSpecs,
      ),
      userMessage: this.buildUserMessage(data, rawSpecs, offerLevelDeterministicSpecs),
      responseSchema: this.buildModelSpecResponseSchema(schema, offerLevelSpecs),
      model: params.model,
      thinking: params.thinking,
      effort: params.effort,
      maxTokens: params.maxTokens,
    });
    if (!response) return undefined;

    const sanitized: ModelSpecContribution = {
      specs: response.specs
        ? this.specNormalizer.normalize(response.specs, schema)
        : undefined,
    };

    if (sanitized.specs === undefined) {
      this.logger.warn(
        'Model-spec post-process contributed nothing usable after sanitization, degrading to deterministic-only',
      );
      return undefined;
    }

    return sanitized;
  }

  private isEmptyContribution(c: OfferIdentityContribution): boolean {
    return (
      c.brand === undefined &&
      c.model === undefined &&
      c.specs === undefined
    );
  }

  /**
   * Shared request/response plumbing for both LLM calls: builds the chat
   * request, applies the reasoning-effort default, guards against
   * truncation, and degrades to `undefined` on any failure. Each public
   * method supplies its own prompt/schema and interprets `response.parsed`
   * itself, since the two calls sanitize/validate slightly differently
   * (offer-identity checks brand/model/specs; model-spec only checks specs).
   */
  private async runContributionCall(
    params: ContributionCallParams,
  ): Promise<RawLlmResponse | undefined> {
    const { systemPrompt, userMessage, responseSchema, model, thinking, effort, maxTokens } =
      params;

    // `effort` implies reasoning is enabled, so only default it in when the
    // caller hasn't explicitly turned reasoning off.
    const resolvedEffort =
      thinking === false ? undefined : (effort ?? DEFAULT_EFFORT);

    try {
      const response = await this.aiChat.createChat({
        costLabel: 'product-source-post-process',
        schema: responseSchema,
        schemaName: 'post_processed_product',
        model: model ?? DEFAULT_MODEL,
        ...(thinking !== undefined && { thinking }),
        ...(resolvedEffort !== undefined && { effort: resolvedEffort }),
        maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 1,
      });

      // A response cut off by the token ceiling fails JSON parsing and would
      // otherwise be indistinguishable from a model that simply answered
      // badly — call it out so the cap is diagnosable rather than mysterious.
      if (response.finishReason === 'length') {
        this.logger.warn(
          'Post-process response hit the token ceiling and was truncated, degrading to deterministic-only — consider raising maxTokens or lowering effort for this source',
          {
            maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
            completionTokens: response.usage.completionTokens,
          },
        );
        return undefined;
      }

      const parsed = response.parsed as RawLlmResponse | undefined;
      if (!parsed) {
        this.logger.warn(
          'Post-process returned no usable output, degrading to deterministic-only',
          { preview: response.content?.slice(0, 200) },
        );
        return undefined;
      }

      return parsed;
    } catch (error: unknown) {
      this.logger.warn(
        'Post-process LLM call failed, degrading to deterministic-only',
        { error: error instanceof Error ? error.message : String(error) },
      );
      return undefined;
    }
  }

  // ─── Shared prompt fragments ────────────────────────────────────────────

  private buildFieldDescriptions(
    schema: SpecDefinitionJsonSchema,
    keys: string[],
  ): string {
    return keys
      .map((key) => {
        const prop = schema.properties[key];
        if (!prop) return undefined;
        const unit = prop.meta?.unit ? `, unit: ${prop.meta.unit}` : '';
        const options = prop.enum?.length
          ? `, allowed values (pick exactly one of these, verbatim): ${prop.enum.join(' | ')}`
          : '';
        const examples =
          !options && prop.meta?.examples?.length
            ? `, examples: ${prop.meta.examples.join(', ')}`
            : '';
        return `- ${key} (${prop.type}${unit}${options}${examples}): ${prop.title}`;
      })
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  private buildTranslationPreamble(schema: SpecDefinitionJsonSchema): string {
    return `You are normalizing product data for the "${schema.title}" category into a fixed canonical shape. The target audience is Hungarian — canonical spec field NAMES stay in English exactly as given below. For string spec VALUES: translate genuine descriptive/category words into Hungarian (e.g. "black" -> "fekete", "front suspension" -> "első felfüggesztés"). Do NOT translate or otherwise alter proper nouns, brand/component/part names, or model-style designations embedded in a value (e.g. "KTM aluminium 34T Direct Mount", "Shimano Deore", "FOX Transfer") — copy these verbatim, character-for-character, including spelling, casing, and any words that happen to look like an untranslated Hungarian/English/German term. Never "correct" the spelling of a value copied from the source — if unsure whether a token is a translatable word or a proper noun/part name, leave it exactly as given rather than guessing.`;
  }

  // ─── Offer-identity prompt/schema ───────────────────────────────────────

  private buildOfferIdentitySystemPrompt(
    schema: SpecDefinitionJsonSchema,
    goldenSample: ProductSpecs,
    offerLevelSpecs: string[],
  ): string {
    const fieldDescriptions = this.buildFieldDescriptions(schema, offerLevelSpecs);
    const goldenSubset = pick(goldenSample, offerLevelSpecs);

    const offerLevelTitles = offerLevelSpecs
      .map((key) => schema.properties[key]?.title)
      .filter((title): title is string => Boolean(title));
    const offerLevelList = offerLevelTitles.join(', ');
    const offerLevelHint = offerLevelTitles.length
      ? ` Pay particular attention to ${offerLevelList} — these are frequently embedded only in the raw title/model text (e.g. a size code like "M/43" or a color name) rather than the structured spec table, and must be extracted from there if present.`
      : '';
    const offerLevelModelHint = offerLevelTitles.length
      ? ` ${offerLevelList} are offer-level fields — they describe a specific purchasable variant/listing (this exact size, this exact color), not the product model's identity — so they must never remain in "model" once extracted.`
      : '';

    return (
      `${this.buildTranslationPreamble(schema)} The "model" field should stay in whatever language the source uses for model names — do not translate it.\n\n` +
      `Canonical spec fields (offer-level only — this call never touches product-identity fields):\n${fieldDescriptions}\n\n` +
      `Worked example — correctly unified offer-level values for this category:\n${JSON.stringify(goldenSubset, null, 2)}\n\n` +
      `The user message has a "data" object with the already-known "brand", a "model" field (the source's raw, uncleaned model/title text — also referred to below as "rawModel"), and "specs" (already deterministically mapped offer-level fields only). You may return any of "brand", "model", "specs" in your response — but only the ones you can confidently produce. Omit any field entirely rather than guessing.\n\n` +
      `Field-specific guidance:\n` +
      `- "model": strip the brand (it's already given separately, don't repeat it), marketing/category boilerplate (e.g. a bike's usage type or "electric bicycle" wording), gender/target-audience words, and year — but first check whether any of these values are new information not already captured in "specs" (e.g. a frame size or color that only appears in the raw title). If so, add them to "specs" under the matching canonical field BEFORE removing them from "model" — the raw title is often the only place such a value appears at all, so stripping it without first extracting it destroys the information rather than just cleaning the name.${offerLevelModelHint} KEEP genuine model designation tokens (line name, numeric/alphanumeric variant codes, edition names like "Di2", "SX", "Prestige"). If the given model text is already clean, return it unchanged. Never invent a model name that isn't derivable from the input.\n` +
      `- "brand": only return this if you can confidently correct or normalize the given brand (e.g. fixing inconsistent casing or a misspelling) based on evidence in the input — never invent or guess a different brand.\n` +
      `- "specs": see the rules below — offer-level keys only.\n\n` +
      `Rules:\n` +
      `- The user message has a "deterministicSpecs" object (already mapped to canonical field names by a label-matching pass, offer-level keys only) and a "rawModel" string (the same raw title referenced above). There is no raw spec table in this call's input — a value that only exists as unmapped raw text is out of scope here.\n` +
      `- Start from deterministicSpecs — those values are already correct (though possibly not yet translated to Hungarian — translate them), keep them unless rawModel gives a more precise value for the same field.\n` +
      `- Then look through rawModel for offer-level canonical fields deterministicSpecs is missing.${offerLevelHint} Extract from it when the value is clearly and unambiguously present.\n` +
      `- For a spec field with "allowed values" listed above, you MUST output one of those exact Hungarian strings — pick the closest semantic match to the source value, never invent a new label or leave the source-language value untranslated.\n` +
      `- Convert spec units/formats to match the golden example's style.\n` +
      `- Only use evidence present in the input. Never invent or guess a spec value for a field the input doesn't support — omit the key entirely instead.\n` +
      `- Return a single JSON object with a "specs" key (offer-level canonical field names only, confidently-known ones only — omit fields you're unsure of) and optional "brand"/"model" keys per the field-specific guidance above.`
    );
  }

  private buildOfferIdentityResponseSchema(
    schema: SpecDefinitionJsonSchema,
    offerLevelSpecs: string[],
  ): unknown {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        brand: { type: 'string' },
        model: { type: 'string' },
        specs: {
          type: 'object',
          additionalProperties: false,
          properties: this.buildSchemaProperties(schema, offerLevelSpecs),
        },
      },
    };
  }

  // ─── Model-spec prompt/schema ────────────────────────────────────────────

  private buildModelSpecSystemPrompt(
    schema: SpecDefinitionJsonSchema,
    goldenSample: ProductSpecs,
    offerLevelSpecs: string[],
  ): string {
    const modelLevelKeys = Object.keys(schema.properties).filter(
      (key) => !offerLevelSpecs.includes(key),
    );
    const fieldDescriptions = this.buildFieldDescriptions(schema, modelLevelKeys);
    const goldenSubset = omit(goldenSample, offerLevelSpecs);

    return (
      `${this.buildTranslationPreamble(schema)}\n\n` +
      `Canonical spec fields (product-identity only — this call never touches brand/model or offer-level fields like size/color, which are handled by a separate pass):\n${fieldDescriptions}\n\n` +
      `Worked example — a correctly unified specs output for this category:\n${JSON.stringify(goldenSubset, null, 2)}\n\n` +
      `The user message has a "data" object with the already-known "brand", a "model" field (the source's raw, uncleaned model/title text — also referred to below as "rawModel"), "specs" (already deterministically mapped), and an "offerLevelSpecs" object of already-known offer-level values (size/color/etc.) — read-only context to help disambiguate product-identity fields, never something to output yourself. Return only the product-identity fields you can confidently produce; omit any field entirely rather than guessing.\n\n` +
      `Rules:\n` +
      `- The user message has a "deterministicSpecs" object (already mapped to canonical field names by a label-matching pass), a "rawModel" string, and, when available, a "rawSpecs" array — the source's full, unmapped spec table (label/value rows exactly as scraped, sometimes grouped under a "section", sometimes a free-text "description" instead of a single value).\n` +
      `- Start from deterministicSpecs — those values are already correct (though possibly not yet translated to Hungarian — translate them), keep them unless rawSpecs or rawModel gives a more precise value for the same field.\n` +
      `- Then look through rawSpecs AND rawModel for canonical spec fields deterministicSpecs is missing. A source may not have a row labeled like the canonical field at all — the value can be embedded inside a free-text component description (e.g. a row named "Motor" with value "Bosch PERFORMANCE SX BDU3144" may be the only place motorPower/motorPosition/brand info appears; a "Váz"/frame row's free text may state the frame type or suspension). Extract from either source when the value is clearly and unambiguously present.\n` +
      `- For a spec field with "allowed values" listed above, you MUST output one of those exact Hungarian strings — pick the closest semantic match to the source value, never invent a new label or leave the source-language value untranslated.\n` +
      `- Convert spec units/formats to match the golden example's style.\n` +
      `- Only use evidence present in the input. Never invent or guess a spec value for a field the input doesn't support — omit the key entirely instead.\n` +
      `- Do not recompute or convert units the input didn't provide (e.g. don't derive torque from motor power).\n` +
      `- Return a single JSON object with a "specs" key only (canonical field names, confidently-known ones only — omit fields you're unsure of). Never return "brand"/"model" — those are not part of this response.`
    );
  }

  private buildModelSpecResponseSchema(
    schema: SpecDefinitionJsonSchema,
    offerLevelSpecs: string[],
  ): unknown {
    const modelLevelKeys = Object.keys(schema.properties).filter(
      (key) => !offerLevelSpecs.includes(key),
    );
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        specs: {
          type: 'object',
          additionalProperties: false,
          properties: this.buildSchemaProperties(schema, modelLevelKeys),
        },
      },
    };
  }

  // ─── Shared user-message + response-schema-property builders ───────────

  private buildUserMessage(
    data: { brand: string; model: string; specs: ProductSpecs },
    rawSpecs?: ScrapedProductSpec[],
    offerLevelContextSpecs?: ProductSpecs,
  ): string {
    const payload: Record<string, unknown> = {
      deterministicSpecs: data.specs,
      rawModel: data.model,
      brand: data.brand,
    };

    // Only the model-spec call receives this — read-only context on the
    // listing's already-known offer-level values, per
    // buildModelSpecSystemPrompt's own instructions. Passed in directly
    // rather than picked from `data.specs`, since `data.specs` here is
    // already the product-level-only object (disjoint from offer-level keys
    // by construction) — picking from it would always yield {}.
    if (offerLevelContextSpecs && !isEmpty(offerLevelContextSpecs)) {
      payload['offerLevelSpecs'] = offerLevelContextSpecs;
    }

    if (rawSpecs?.length) {
      payload['rawSpecs'] = rawSpecs.map((spec) => ({
        name: spec.name,
        ...(spec.sectionTitle ? { section: spec.sectionTitle } : {}),
        ...(spec.description ? { description: spec.description } : {}),
        ...(spec.values ? { values: spec.values } : {}),
      }));
    }

    return JSON.stringify(payload);
  }

  /**
   * Builds strict-mode-valid JSON Schema properties for a "specs" object,
   * restricted to `keys` — derived from the category's
   * SpecDefinitionJsonSchema properties.
   *
   * Cannot pass `schema.properties` straight through: SpecDefinitionProperty
   * carries a `meta` key (unit/examples/order — our own convention, read by
   * the system-prompt builders) and a `title`, neither of which are schema
   * keywords. Ajv's `strict: true` mode (used by AiSchemaValidatorService)
   * rejects unknown keywords outright, so passing them through fails
   * `ajv.compile(schema)` before the LLM call is even validated. `enum` is a
   * real schema keyword, so it passes through as-is.
   */
  private buildSchemaProperties(
    schema: SpecDefinitionJsonSchema,
    keys: string[],
  ): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    for (const key of keys) {
      const prop = schema.properties[key];
      if (!prop) continue;
      if (prop.type === 'array') {
        properties[key] = { type: 'array', items: { type: 'string' } };
      } else if (prop.type === 'string' && prop.enum?.length) {
        properties[key] = { type: 'string', enum: prop.enum };
      } else {
        properties[key] = { type: prop.type };
      }
    }
    return properties;
  }
}
