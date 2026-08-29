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

/**
 * TEMPORARY EXPERIMENT (2026-08-29): swapped from 'deepseek-v4-flash' to
 * OpenAI's gpt-5.6-luna, to compare cost/accuracy against the DeepSeek
 * baseline established earlier this session on the same two sources
 * (ebikeshop, speedbike). Revert to 'deepseek-v4-flash' once compared.
 */
const DEFAULT_MODEL = 'gpt-5.6-luna';

/**
 * Reasoning is left ON by default because the pass genuinely depends on it:
 * most sources publish a free-text OEM component list, and canonical fields
 * (motorPosition from a Bosch `BDU*` code, seatpostType from "FOX Transfer",
 * tubeless from a `TLE`/`TLR` token, equipment booleans from blank rows) exist
 * only as inferences over that text. Not sent explicitly — DeepSeek's
 * reasoning models already default to thinking enabled
 * (api-docs.deepseek.com/guides/thinking_mode), so omitting the field relies
 * on that default rather than re-asserting it. Confirmed necessary by a
 * direct `thinking: false` experiment (2026-08-29): cost dropped ~85%, but
 * the model-spec call fabricated data — e.g. copying the motor model string
 * verbatim into unrelated forkModel/rearShockModel/seatpost fields with a
 * fabricated `forkTravel: 0`/`rearTravel: 0`, and silently dropping a
 * weight correction (25 -> 25.9) that every reasoning-on run got right.
 * Sources with an already-normalized spec table (no free-text inference
 * needed) should set `thinking: false` per-source instead, which also
 * suppresses `effort` (see runContributionCall) since DeepSeek has no
 * "disabled reasoning at a specific effort" state.
 *
 * Both calls default to high effort. model-spec reconciles the full
 * non-offer-level field set (~50-90 fields) against deterministicSpecs/
 * rawSpecs, and a medium-effort run measurably regressed on real data — e.g.
 * a KTM source with a clearly-present display module coming back
 * `display: false`, which low/medium runs got right previously
 * (2026-08-29). offer-identity was originally left at medium on the
 * assumption that reconciling a handful of fields (brand/model/one or two
 * offer-level keys) doesn't need much reasoning, but it missed a colorway
 * name embedded in the raw title — "Space Galaxy Matt (Grey+Black)" was
 * kept in `model` instead of extracted to `color` (2026-08-29, product
 * a0517278-d003-42e3-9826-1c0b35daa019). Bumped to high alongside a prompt
 * fix for that specific case; revisit if high doesn't clear misses like it
 * either.
 */
const DEFAULT_OFFER_IDENTITY_EFFORT = 'high';
const DEFAULT_MODEL_SPECS_EFFORT = 'high';

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
   * all — its inputs are the raw title/model text, the already-mapped
   * offer-level specs, and (only when the caller opts in via
   * ProductSourcePostProcessConfig.includeDescriptionInOfferIdentity) the
   * source's free-text description; a value that lives only in unmapped raw
   * text (no SourceSpecMapping pointing at it) is out of scope for this
   * call.
   */
  async processOfferIdentity(params: {
    data: Pick<DeterministicProductData, 'brand' | 'model'> & {
      specs: ProductSpecs;
    };
    description?: string;
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    offerLevelSpecs: string[];
    model?: string;
    thinking?: boolean;
    effort?: string;
    maxTokens?: number;
  }): Promise<OfferIdentityContribution | undefined> {
    const { data, description, schema, goldenSample, offerLevelSpecs } = params;

    const response = await this.runContributionCall({
      systemPrompt: this.buildOfferIdentitySystemPrompt(
        schema,
        goldenSample,
        offerLevelSpecs,
      ),
      userMessage: this.buildUserMessage(data, undefined, undefined, description),
      responseSchema: this.buildOfferIdentityResponseSchema(
        schema,
        offerLevelSpecs,
      ),
      model: params.model,
      thinking: params.thinking,
      effort: params.effort ?? DEFAULT_OFFER_IDENTITY_EFFORT,
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
    description?: string;
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    offerLevelSpecs: string[];
    model?: string;
    thinking?: boolean;
    effort?: string;
    maxTokens?: number;
  }): Promise<ModelSpecContribution | undefined> {
    const {
      data,
      offerLevelDeterministicSpecs,
      rawSpecs,
      description,
      schema,
      goldenSample,
      offerLevelSpecs,
    } = params;

    const response = await this.runContributionCall({
      systemPrompt: this.buildModelSpecSystemPrompt(
        schema,
        goldenSample,
        offerLevelSpecs,
      ),
      userMessage: this.buildUserMessage(
        data,
        rawSpecs,
        offerLevelDeterministicSpecs,
        description,
      ),
      responseSchema: this.buildModelSpecResponseSchema(schema, offerLevelSpecs),
      model: params.model,
      thinking: params.thinking,
      effort: params.effort ?? DEFAULT_MODEL_SPECS_EFFORT,
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
   * request, guards against truncation, and degrades to `undefined` on any
   * failure. Each public method resolves its own effort default
   * (DEFAULT_OFFER_IDENTITY_EFFORT/DEFAULT_MODEL_SPECS_EFFORT) before
   * calling in, and supplies its own prompt/schema and interprets
   * `response.parsed` itself, since the two calls sanitize/validate
   * slightly differently (offer-identity checks brand/model/specs;
   * model-spec only checks specs).
   */
  private async runContributionCall(
    params: ContributionCallParams,
  ): Promise<RawLlmResponse | undefined> {
    const { systemPrompt, userMessage, responseSchema, model, thinking, effort, maxTokens } =
      params;

    // `thinking` is only forwarded when a caller explicitly sets it —
    // DeepSeek's reasoning models already default to enabled, so leaving it
    // unset relies on that default rather than re-asserting it. `effort`
    // only takes effect while thinking is (implicitly or explicitly)
    // enabled, so it's dropped when the caller has explicitly turned
    // reasoning off, even if a per-call default was resolved upstream.
    const resolvedEffort = thinking === false ? undefined : effort;

    try {
      const response = await this.aiChat.createChat({
        costLabel: 'product-source-post-process',
        schema: responseSchema,
        schemaName: 'post_processed_product',
        model: model ?? DEFAULT_MODEL,
        ...(thinking !== undefined && { thinking }),
        ...(resolvedEffort !== undefined && { effort: resolvedEffort }),
        ...(maxTokens !== undefined && { maxTokens }),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 1,
      });

      // A response cut off by the provider's own token ceiling (or an
      // explicit per-source maxTokens override) fails JSON parsing and would
      // otherwise be indistinguishable from a model that simply answered
      // badly — call it out so the cap is diagnosable rather than mysterious.
      if (response.finishReason === 'length') {
        this.logger.warn(
          'Post-process response hit the token ceiling and was truncated, degrading to deterministic-only — consider setting maxTokens or lowering effort for this source',
          {
            maxTokens,
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
    const colorNamingHint = offerLevelSpecs.includes('color')
      ? ` Manufacturers often give a color a stylized marketing name instead of a plain color word (e.g. "Space Galaxy Matt", "Olive Pearl") — sometimes followed by a literal breakdown in parentheses right after it (e.g. "Space Galaxy Matt (Grey+Black)"). Treat the stylized name together with any such parenthetical as one "color" value — never leave the stylized name in "model" while dropping the parenthetical, and never leave either part unextracted just because it isn't a plain color word.`
      : '';
    const offerLevelHint = offerLevelTitles.length
      ? ` Pay particular attention to ${offerLevelList} — these are frequently embedded only in the raw title/model text (e.g. a size code like "M/43" or a color name) rather than the structured spec table, and must be extracted from there if present.${colorNamingHint}`
      : '';
    const offerLevelModelHint = offerLevelTitles.length
      ? ` ${offerLevelList} are offer-level fields — they describe a specific purchasable variant/listing (this exact size, this exact color), not the product model's identity — so they must never remain in "model" once extracted.`
      : '';

    return (
      `${this.buildTranslationPreamble(schema)} The "model" field should stay in whatever language the source uses for model names — do not translate it.\n\n` +
      `Canonical spec fields (offer-level only — this call never touches product-identity fields):\n${fieldDescriptions}\n\n` +
      `Worked example — correctly unified offer-level values for this category:\n${JSON.stringify(goldenSubset)}\n\n` +
      `The user message has a "data" object with the already-known "brand", a "model" field (the source's raw, uncleaned model/title text — also referred to below as "rawModel"), and "specs" (already deterministically mapped offer-level fields only). You may return any of "brand", "model", "specs" in your response — but only the ones you can confidently produce. Omit any field entirely rather than guessing.\n\n` +
      `Field-specific guidance:\n` +
      `- "model": strip the brand (it's already given separately, don't repeat it), marketing/category boilerplate (e.g. a bike's usage type or "electric bicycle" wording), gender/target-audience words, and year — but first check whether any of these values are new information not already captured in "specs" (e.g. a frame size or color that only appears in the raw title). If so, add them to "specs" under the matching canonical field BEFORE removing them from "model" — the raw title is often the only place such a value appears at all, so stripping it without first extracting it destroys the information rather than just cleaning the name.${offerLevelModelHint} KEEP genuine model designation tokens (line name, numeric/alphanumeric variant codes, edition names like "Di2", "SX", "Prestige"). If the given model text is already clean, return it unchanged. Never invent a model name that isn't derivable from the input.\n` +
      `- "brand": only return this if you can confidently correct or normalize the given brand (e.g. fixing inconsistent casing or a misspelling) based on evidence in the input — never invent or guess a different brand.\n` +
      `- "specs": see the rules below — offer-level keys only.\n\n` +
      `Rules:\n` +
      `- The user message has a "deterministicSpecs" object (already mapped to canonical field names by a label-matching pass, offer-level keys only) and a "rawModel" string (the same raw title referenced above). There is no raw spec table in this call's input — a value that only exists as unmapped raw text is out of scope here.\n` +
      `- Start from deterministicSpecs — those values are already correct (though possibly not yet translated to Hungarian — translate them), keep them unless rawModel gives a more precise value for the same field.\n` +
      `- Then look through rawModel for offer-level canonical fields deterministicSpecs is missing.${offerLevelHint} Extract from it when the value is clearly and unambiguously present.\n` +
      `- When available, the user message also has a top-level "description" string — the listing's own marketing/product-description prose. Treat it as LOWER confidence than rawModel: it's unstructured sales copy, not a title, so it can restate a value correctly, omit it, or describe it only vaguely/figuratively. Only extract an offer-level value from it when clearly, specifically, and unambiguously stated — never from general marketing tone alone. When deterministicSpecs/rawModel already has a value for a field, prefer it over anything implied by description.\n` +
      `- For a spec field with "allowed values" listed above: if the source gives a value for that field, you MUST translate/normalize it to one of those exact Hungarian strings (never invent a new label, never leave it untranslated) — but only when the source value genuinely describes that field's own concept. A source value describing a *different* concept (e.g. a riding-discipline/category term like "All Mountain" when the field asks for frame geometry, or a gendered variant like "Cross férfi" when a category-only enum value like "Cross Trekking" fits better) must be routed to whichever field it actually matches, or dropped if no field fits — never force it into an enum value it doesn't really mean just because the field has no other value to offer. If nothing in the input specifically describes what the field is asking about, omit the key.\n` +
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
    const modelLevelKeys = this.getModelLevelKeys(schema, offerLevelSpecs);
    const fieldDescriptions = this.buildFieldDescriptions(schema, modelLevelKeys);
    const goldenSubset = omit(goldenSample, offerLevelSpecs);

    return (
      `${this.buildTranslationPreamble(schema)}\n\n` +
      `Canonical spec fields (product-identity only — this call never touches brand/model or offer-level fields like size/color, which are handled by a separate pass):\n${fieldDescriptions}\n\n` +
      `Worked example — a correctly unified specs output for this category, showing value/format conventions (real responses are usually much smaller — see the "specs" rule below):\n${JSON.stringify(goldenSubset)}\n\n` +
      `The user message has a "data" object with the already-known "brand", a "model" field (the source's raw, uncleaned model/title text — also referred to below as "rawModel"), "specs" (already deterministically mapped), and an "offerLevelSpecs" object of already-known offer-level values (size/color/etc.) — read-only context to help disambiguate product-identity fields, never something to output yourself. Return only the product-identity fields you can confidently produce; omit any field entirely rather than guessing.\n\n` +
      `Rules:\n` +
      `- The user message has a "deterministicSpecs" object (already mapped to canonical field names by a label-matching pass), a "rawModel" string, and, when available, a "rawSpecs" array — the source's full, unmapped spec table (label/value rows exactly as scraped, sometimes grouped under a "section", sometimes carrying their own per-row free-text "description" instead of a single value).\n` +
      `- deterministicSpecs is already merged in automatically after your response — you never need to repeat a value that's already correct there. Only include a key in your "specs" output when your value is NEW (the field is missing or empty in deterministicSpecs) or a CORRECTION (rawSpecs/rawModel clearly gives a more precise/different value than what deterministicSpecs has). If deterministicSpecs already has the right value for a field, omit that key entirely — do not echo it back.\n` +
      `- Then look through rawSpecs AND rawModel for canonical spec fields deterministicSpecs is missing. A source may not have a row labeled like the canonical field at all — the value can be embedded inside a free-text component description (e.g. a row named "Motor" with value "Bosch PERFORMANCE SX BDU3144" may be the only place motorPower/motorPosition/brand info appears; a "Váz"/frame row's free text may state the frame type or suspension). Extract from either source when the value is clearly and unambiguously present.\n` +
      `- When available, the user message also has a top-level "description" string — the listing's own marketing/product-description prose (distinct from a rawSpecs row's own per-row "description" field above). Treat it as LOWER confidence than rawSpecs or rawModel: it's unstructured sales copy, not a labeled spec table, so it can restate a spec correctly, omit it, or describe it only vaguely/figuratively. Only extract a value from it when a spec is clearly, specifically, and unambiguously stated (e.g. "a váz felső csövéből egyszerűen eltávolítható akkumulátor" clearly states batteryRemovable=true) — never from general marketing tone or a category/discipline claim alone (e.g. "versenyorientált fully kerékpár" praising a bike as competition-oriented does NOT by itself justify picking a specific usageType/frameType enum value unless that value is genuinely and specifically what the sentence describes). When rawSpecs/deterministicSpecs already has a value for a field, prefer it over anything implied by description.\n` +
      `- For a spec field with "allowed values" listed above: if the source gives a value for that field, you MUST translate/normalize it to one of those exact Hungarian strings (never invent a new label, never leave it untranslated) — but only when the source value genuinely describes that field's own concept. A source value describing a *different* concept (e.g. a riding-discipline/category term like "All Mountain" when the field asks for frame geometry, or a gendered variant like "Cross férfi" when a category-only enum value like "Cross Trekking" fits better) must be routed to whichever field it actually matches, or dropped if no field fits — never force it into an enum value it doesn't really mean just because the field has no other value to offer. If nothing in the input specifically describes what the field is asking about, omit the key.\n` +
      `- Convert spec units/formats to match the golden example's style.\n` +
      `- Only use evidence present in the input. Never invent or guess a spec value for a field the input doesn't support — omit the key entirely instead.\n` +
      `- Do not recompute or convert units the input didn't provide (e.g. don't derive torque from motor power).\n` +
      `- Return a single JSON object with a "specs" key only — new/corrected canonical fields only, never values already matching deterministicSpecs. Never return "brand"/"model" — those are not part of this response.`
    );
  }

  private buildModelSpecResponseSchema(
    schema: SpecDefinitionJsonSchema,
    offerLevelSpecs: string[],
  ): unknown {
    const modelLevelKeys = this.getModelLevelKeys(schema, offerLevelSpecs);
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

  private getModelLevelKeys(
    schema: SpecDefinitionJsonSchema,
    offerLevelSpecs: string[],
  ): string[] {
    return Object.keys(schema.properties).filter(
      (key) => !offerLevelSpecs.includes(key),
    );
  }

  // ─── Shared user-message + response-schema-property builders ───────────

  private buildUserMessage(
    data: { brand: string; model: string; specs: ProductSpecs },
    rawSpecs?: ScrapedProductSpec[],
    offerLevelContextSpecs?: ProductSpecs,
    description?: string,
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

    // Free-text marketing description. Only the source's own config
    // populates it (most sources have none), and only when the caller opts
    // this call into receiving it (ProductSourcePostProcessConfig's
    // includeDescriptionInOfferIdentity/includeDescriptionInModelSpecs —
    // see ProductDetailsPageScraperService.maybePostProcess). Both prompts
    // that can request it treat it as lower confidence than rawModel/
    // rawSpecs, per their own "description" rule below.
    if (description?.trim()) {
      payload['description'] = description.trim();
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
