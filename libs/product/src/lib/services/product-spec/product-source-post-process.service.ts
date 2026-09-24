import { Injectable } from '@nestjs/common';
import { AiChatService } from '@fittkereso-backend/ai';
import type {
  ProductSpecs,
  ScrapedProductSpec,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { isEmpty, pick } from 'lodash';
import { ProductSpecNormalizationService } from './product-spec-normalization.service';

/**
 * gpt-6-luna since 2026-09-23, replacing gpt-5.6-luna (itself swapped in from
 * 'deepseek-v4-flash' on 2026-08-29). Chosen from a side-by-side replay of 24
 * logged production prompts at high effort: ~74% cheaper per listing
 * ($0.0014 vs $0.0053 for offer-identity + model-spec), mostly from using
 * about half the reasoning tokens on model-spec at 42% of the output price.
 * On its own it omitted component-implied inferences the model-spec call
 * exists for (see buildModelSpecSystemPrompt's "categorical or yes/no" rule,
 * added for exactly this); with that rule its recall on those fields matched
 * gpt-5.6-luna's.
 */
const DEFAULT_MODEL = 'gpt-6-luna';

/**
 * Reasoning is left ON by default because the pass genuinely depends on it:
 * most sources publish a free-text OEM component list, and canonical fields
 * (motorPosition from a Bosch `BDU*` code, seatpostType from "FOX Transfer",
 * tubeless from a `TLE`/`TLR` token, equipment booleans from blank rows) exist
 * only as inferences over that text. `thinking` is not sent explicitly: the
 * default OpenAI reasoning models always reason (only `effort` tunes how
 * much), and DeepSeek's reasoning models default to thinking enabled
 * (api-docs.deepseek.com/guides/thinking_mode). Confirmed necessary by a
 * direct DeepSeek `thinking: false` experiment (2026-08-29): cost dropped ~85%, but
 * the model-spec call fabricated data — e.g. copying the motor model string
 * verbatim into unrelated forkModel/rearShockModel/seatpost fields with a
 * fabricated `forkTravel: 0`/`rearTravel: 0`, and silently dropping a
 * weight correction (25 -> 25.9) that every reasoning-on run got right.
 * Sources with an already-normalized spec table (no free-text inference
 * needed) should lower `effort` per-source instead. On a DeepSeek model,
 * `thinking: false` also works and suppresses `effort` (see
 * runContributionCall) since DeepSeek has no "disabled reasoning at a
 * specific effort" state; OpenAI ignores `thinking`, so there it only drops
 * effort back to the model's default.
 *
 * Both calls default to high effort. Unification reconciles ~90 fields
 * against deterministicSpecs/rawSpecs, and a medium-effort run measurably
 * regressed on real data — e.g. a KTM source with a clearly-present display
 * module coming back `display: false`, which low/medium runs got right
 * previously (2026-08-29). The identity extraction descends from the old
 * offer-identity call, which missed a colorway name embedded in the raw title
 * at medium — "Space Galaxy Matt (Grey+Black)" was kept in `model` instead of
 * extracted to `color` (2026-08-29, product
 * a0517278-d003-42e3-9826-1c0b35daa019) — and it was measured at high
 * (2026-09-23: $0.00031 per listing, 7.8 of 12 identity specs filled on
 * speedbike). Re-checked on gpt-6-luna (2026-09-23): medium dropped even more
 * inference fields than high, and xhigh doubled model-spec cost while
 * recovering only part of them — so high stays, with the prompt carrying the
 * rest.
 */
const DEFAULT_IDENTITY_EFFORT = 'high';
const DEFAULT_MODEL_SPECS_EFFORT = 'high';

/** Deterministic, pre-LLM view of a scraped product. */
export interface DeterministicProductData {
  brand: string;
  model: string;
  specs: ProductSpecs;
}

/**
 * What the identity extraction may confidently contribute: a cleaned model
 * name, a corrected brand, and values for the category's identity fields
 * (primary, matcher and offer-level specs). Fields the LLM isn't confident
 * about are omitted rather than guessed.
 */
export interface IdentityContribution {
  brand?: string;
  model?: string;
  specs?: ProductSpecs;
}

/**
 * What full spec unification may confidently contribute — only the fields
 * outside the identity set. This call never touches brand/model.
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
 * Post-processes a source's deterministically-extracted data via two LLM
 * calls with different scopes and very different frequencies:
 *  - `extractIdentity`, once per first-seen (or changed) listing: cleans the
 *    raw title down to the model name, optionally corrects the brand, and
 *    fills the category's identity fields — the primary and matcher specs
 *    that decide which product a listing is, plus the offer-level specs
 *    (size, colour) that describe the listing itself. Guided by the category
 *    schema alone: a golden sample was measured to change nothing here and
 *    to make frameSize worse.
 *  - `processModelSpecs` (full spec unification), once per product per
 *    source: every other schema field — the ones behind website filters and
 *    the product page — with the identity values as read-only context and
 *    the golden sample, picked to its own fields, as a style example.
 *
 * Every key list comes from the caller, which reads it from the category
 * config: nothing here names a spec, so a category with different fields
 * works unchanged.
 *
 * Both run AFTER SpecExtractionService, not instead of it — the deterministic
 * pass already did unit stripping/number extraction/value remapping; these
 * calls only re-key/re-shape into the canonical field set for sources whose
 * raw labels don't line up with the category's SourceSpecMapping[] entries.
 *
 * Each returns only what the LLM confidently contributed (or `undefined` on
 * any failure) — never a value pre-merged with deterministic data. Merging is
 * ProductSourcePostProcessMergeService's job, so "no LLM contribution" has
 * exactly one shape (`undefined`) regardless of why: disabled, thrown error,
 * or an empty parsed response. Mirrors TranslationService's
 * degrade-on-failure contract: any internal error (LLM call failure, schema
 * validation failure) is caught and never thrown — a failed post-process pass
 * should not fail the whole scrape.
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
   * The identity extraction. `data.specs` is expected to be the deterministic
   * values of `outputKeys` only, and `rawSpecs` the rows the source's
   * `identityExtraction.specRows` selected (the whole table when it names
   * none) — this method sends what it is given.
   */
  async extractIdentity(params: {
    data: Pick<DeterministicProductData, 'brand' | 'model'> & {
      specs: ProductSpecs;
    };
    rawSpecs?: ScrapedProductSpec[];
    description?: string;
    schema: SpecDefinitionJsonSchema;
    /** Every field this call fills: the category's primary, matcher and offer-level specs. */
    outputKeys: string[];
    /** The listing-level subset of `outputKeys` (size, colour) — never part of the model name. */
    offerLevelSpecs: string[];
    model?: string;
    thinking?: boolean;
    effort?: string;
    maxTokens?: number;
  }): Promise<IdentityContribution | undefined> {
    const { data, rawSpecs, description, schema, outputKeys, offerLevelSpecs } =
      params;

    const response = await this.runContributionCall({
      systemPrompt: this.buildIdentitySystemPrompt(
        schema,
        outputKeys,
        offerLevelSpecs,
      ),
      userMessage: this.buildUserMessage(data, rawSpecs, undefined, description),
      responseSchema: this.buildIdentityResponseSchema(schema, outputKeys),
      model: params.model,
      thinking: params.thinking,
      effort: params.effort ?? DEFAULT_IDENTITY_EFFORT,
      maxTokens: params.maxTokens,
    });
    if (!response) return undefined;

    const sanitized: IdentityContribution = {
      brand: response.brand?.trim() || undefined,
      model: response.model?.trim() || undefined,
      specs: response.specs
        ? this.specNormalizer.normalize(response.specs, schema)
        : undefined,
    };

    if (this.isEmptyContribution(sanitized)) {
      this.logger.warn(
        'Identity extraction contributed nothing usable after sanitization, degrading to deterministic-only',
      );
      return undefined;
    }

    return sanitized;
  }

  /**
   * Full spec unification — the expensive, reasoning-heavy call, run once per
   * product per source. `data.specs` is expected to be the deterministic
   * values of `outputKeys`; `knownSpecs` carries the identity extraction's
   * settled values purely as read-only prompt context. Gets the full rawSpecs
   * for complete context, but its response schema holds `outputKeys` only, so
   * it can never re-derive or overwrite an identity value.
   */
  async processModelSpecs(params: {
    data: DeterministicProductData;
    /** Values an earlier pass settled for this listing — context, never output. */
    knownSpecs?: ProductSpecs;
    rawSpecs?: ScrapedProductSpec[];
    description?: string;
    schema: SpecDefinitionJsonSchema;
    /** Every field this call fills: the schema minus the identity fields. */
    outputKeys: string[];
    /** The category's one golden sample; only its `outputKeys` are shown. */
    goldenSample?: ProductSpecs;
    model?: string;
    thinking?: boolean;
    effort?: string;
    maxTokens?: number;
  }): Promise<ModelSpecContribution | undefined> {
    const {
      data,
      knownSpecs,
      rawSpecs,
      description,
      schema,
      outputKeys,
      goldenSample,
    } = params;

    const response = await this.runContributionCall({
      systemPrompt: this.buildModelSpecSystemPrompt(
        schema,
        outputKeys,
        pick(goldenSample ?? {}, outputKeys),
      ),
      userMessage: this.buildUserMessage(data, rawSpecs, knownSpecs, description),
      responseSchema: this.buildModelSpecResponseSchema(schema, outputKeys),
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

  private isEmptyContribution(c: IdentityContribution): boolean {
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
   * (DEFAULT_IDENTITY_EFFORT/DEFAULT_MODEL_SPECS_EFFORT) before calling in,
   * and supplies its own prompt/schema and interprets `response.parsed`
   * itself, since the two calls sanitize/validate slightly differently
   * (identity checks brand/model/specs; unification only checks specs).
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

  private buildAllowedValuesRule(): string {
    return `- For a spec field with "allowed values" listed above: if the source gives a value for that field, you MUST translate/normalize it to one of those exact Hungarian strings (never invent a new label, never leave it untranslated) — but only when the source value genuinely describes that field's own concept. A source value describing a *different* concept (e.g. a riding-discipline/category term like "All Mountain" when the field asks for frame geometry, or a gendered variant like "Cross férfi" when a category-only enum value like "Cross Trekking" fits better) must be routed to whichever field it actually matches, or dropped if no field fits — never force it into an enum value it doesn't really mean just because the field has no other value to offer. If nothing in the input specifically describes what the field is asking about, omit the key.\n`;
  }

  // ─── Identity extraction prompt/schema ──────────────────────────────────

  private buildIdentitySystemPrompt(
    schema: SpecDefinitionJsonSchema,
    outputKeys: string[],
    offerLevelSpecs: string[],
  ): string {
    const fieldDescriptions = this.buildFieldDescriptions(schema, outputKeys);

    const offerLevelTitles = offerLevelSpecs
      .filter((key) => outputKeys.includes(key))
      .map((key) => schema.properties[key]?.title)
      .filter((title): title is string => Boolean(title));
    const offerLevelList = offerLevelTitles.join(', ');
    const colorNamingHint = outputKeys.includes('color')
      ? ` Manufacturers often give a color a stylized marketing name instead of a plain color word (e.g. "Space Galaxy Matt", "Olive Pearl") — sometimes followed by a literal breakdown in parentheses right after it (e.g. "Space Galaxy Matt (Grey+Black)"). Treat the stylized name together with any such parenthetical as one "color" value — never leave the stylized name in "model" while dropping the parenthetical, and never leave either part unextracted just because it isn't a plain color word.`
      : '';
    const offerLevelRule = offerLevelTitles.length
      ? `- Pay particular attention to ${offerLevelList} — these are frequently embedded only in the raw title rather than the spec table (e.g. a size code like "M/43" or a color name), and must be extracted from there if present.${colorNamingHint}\n`
      : '';
    const offerLevelModelHint = offerLevelTitles.length
      ? ` ${offerLevelList} describe this specific listing (this exact size, this exact color), not the product model, so they must never remain in "model" once extracted.`
      : '';
    // The year is the one identity field shops mostly print only in the
    // title, and the one whose formats vary most ('26, MY26, 2026).
    const yearRule = outputKeys.includes('modelYear')
      ? `- modelYear: take it from an explicit year field in rawSpecs or deterministicSpecs when there is one (a two-digit value such as "26" means 2026); otherwise from the title ("'26", "MY26", "2026" all mean 2026). When an explicit field and the title disagree, the explicit field wins. Never assume a year the input does not state.\n`
      : '';

    return (
      `${this.buildTranslationPreamble(schema)} The "model" field should stay in whatever language the source uses for model names — do not translate it.\n\n` +
      `Canonical spec fields — the ones that tell this product apart from similar ones, plus the ones that describe this specific listing:\n${fieldDescriptions}\n\n` +
      `The user message has the already-known "brand", "rawModel" (the source's raw, uncleaned product title), "deterministicSpecs" (values a label-matching pass already mapped onto the canonical fields above) and, when available, "rawSpecs" — rows from the source's spec table, label/value exactly as scraped, sometimes grouped under a "section", sometimes carrying a per-row free-text "description". Return "brand", "model" and "specs", each only as far as you can confidently produce it — omit anything rather than guessing.\n\n` +
      `Field-specific guidance:\n` +
      `- "model": strip the brand (it's already given separately, don't repeat it), marketing/category boilerplate (e.g. a bike's usage type or "electric bicycle" wording), gender/target-audience words, and the year — but first move every canonical field value the title states (a size, a color, a model year, a frame type, ...) into "specs" when "specs" does not already have it, BEFORE removing it from "model". The raw title is often the only place such a value appears at all, so stripping it without first extracting it destroys the information rather than just cleaning the name.${offerLevelModelHint} KEEP genuine model designation tokens (line name, numeric/alphanumeric variant codes, edition names like "Di2", "SX", "Prestige"). If the given title is already clean, return it unchanged. Never invent a model name that isn't derivable from the input.\n` +
      `- "brand": only return this if you can confidently correct or normalize the given brand (e.g. fixing inconsistent casing or a misspelling) based on evidence in the input — never invent or guess a different brand.\n` +
      `- "specs": see the rules below.\n\n` +
      `Rules for "specs":\n` +
      `- Aim to fill every canonical field above that the input supports. These fields decide which product this listing is: a value left out can let two different products merge, and a wrong one splits one product in two.\n` +
      `- deterministicSpecs is merged in automatically after your response — only include a key when your value is NEW (the field is missing in deterministicSpecs) or a CORRECTION (rawModel or rawSpecs clearly gives a more precise or different value). Do not echo back a value deterministicSpecs already has right.\n` +
      `- Look through rawModel and rawSpecs for every field deterministicSpecs is missing. A source may not have a row labeled like the canonical field at all — the value can sit inside a free-text component row (e.g. a "Motor" row naming the drive unit, a frame row stating the material or the suspension). Extract it when it is clearly and unambiguously present.\n` +
      yearRule +
      offerLevelRule +
      `- A categorical or yes/no value that follows directly from a named component or a stated limit counts as clearly present — include it rather than omitting it (e.g. a spec table listing a rear shock describes a full-suspension frame). This never extends to numbers: never fill a numeric field (power, torque, capacity, weight, size, etc.) from your own knowledge of a component — only from a number actually written in the input.\n` +
      `- When available, the user message also has a top-level "description" string — the listing's own marketing prose. Treat it as LOWER confidence than rawModel or rawSpecs: only extract a value from it when clearly, specifically and unambiguously stated, never from general marketing tone, and prefer rawModel/rawSpecs/deterministicSpecs whenever they have a value for the same field.\n` +
      this.buildAllowedValuesRule() +
      `- Give a number in the unit shown for its field above, as a bare number.\n` +
      `- Only use evidence present in the input. Never invent or guess a spec value for a field the input doesn't support — omit the key entirely instead.\n` +
      `- Return a single JSON object with a "specs" key (the canonical field names above only, confidently-known values only) and optional "brand"/"model" keys per the field-specific guidance above.`
    );
  }

  private buildIdentityResponseSchema(
    schema: SpecDefinitionJsonSchema,
    outputKeys: string[],
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
          properties: this.buildSchemaProperties(schema, outputKeys),
        },
      },
    };
  }

  // ─── Unification prompt/schema ───────────────────────────────────────────

  private buildModelSpecSystemPrompt(
    schema: SpecDefinitionJsonSchema,
    outputKeys: string[],
    goldenSubset: ProductSpecs,
  ): string {
    const fieldDescriptions = this.buildFieldDescriptions(schema, outputKeys);
    // Without a golden sample the section is left out entirely rather than
    // rendered around an empty object, which would read as "output nothing".
    const workedExample = isEmpty(goldenSubset)
      ? ''
      : `Worked example — a correctly unified specs output for this category, showing value/format conventions (real responses are usually much smaller — see the "specs" rule below):\n${JSON.stringify(goldenSubset)}\n\n`;
    const unitRule = isEmpty(goldenSubset)
      ? `- Give a number in the unit shown for its field above, as a bare number.\n`
      : `- Convert spec units/formats to match the golden example's style.\n`;

    return (
      `${this.buildTranslationPreamble(schema)}\n\n` +
      `Canonical spec fields (this call never touches brand/model, nor the listing's identity fields — model year, size, color and the like — which an earlier pass already settled):\n${fieldDescriptions}\n\n` +
      workedExample +
      `The user message has a "data" object with the already-known "brand", a "model" field (the source's raw, uncleaned model/title text — also referred to below as "rawModel"), "specs" (already deterministically mapped), and a "knownSpecs" object of values already settled for this listing — read-only context to help disambiguate the fields above, never something to output yourself. Return only the fields above that you can confidently produce; omit any field entirely rather than guessing.\n\n` +
      `Rules:\n` +
      `- The user message has a "deterministicSpecs" object (already mapped to canonical field names by a label-matching pass), a "rawModel" string, and, when available, a "rawSpecs" array — the source's full, unmapped spec table (label/value rows exactly as scraped, sometimes grouped under a "section", sometimes carrying their own per-row free-text "description" instead of a single value).\n` +
      `- deterministicSpecs is already merged in automatically after your response — you never need to repeat a value that's already correct there. Only include a key in your "specs" output when your value is NEW (the field is missing or empty in deterministicSpecs) or a CORRECTION (rawSpecs/rawModel clearly gives a more precise/different value than what deterministicSpecs has). If deterministicSpecs already has the right value for a field, omit that key entirely — do not echo it back.\n` +
      // gpt-6-luna omits these inferences without this nudge (~half of them
      // on the 2026-09-23 replay). The "never numbers" sentence is what
      // stopped it from filling motorPower/torque from its own knowledge of
      // a named drive unit.
      `- A categorical or yes/no value that follows directly from a named component or a stated limit counts as clearly present — include it rather than omitting it: e.g. a Bosch Performance Line / BDU drive unit is a mid-drive motor (motorPosition), a Shimano shifter/derailleur without Di2 is mechanical shiftingActuation while Di2/AXS is electronic, a stated 25 km/h assist limit means pedelecClass "Pedelec", a named display or remote (Purion, Kiox, LED Remote, Mini Remote) means display true, and "Smart System" components mean smartConnectivity true. An equipment row that is present in rawSpecs but has no value (e.g. "Első sárvédő" with empty values) means that item is not included. This never extends to numbers: never fill a numeric field (power, torque, capacity, travel, weight, etc.) from your own knowledge of a component — only from a number actually written in the input.\n` +
      `- Then look through rawSpecs AND rawModel for canonical spec fields deterministicSpecs is missing. A source may not have a row labeled like the canonical field at all — the value can be embedded inside a free-text component description (e.g. a row named "Motor" with value "Bosch PERFORMANCE SX BDU3144" may be the only place motorPower/motorPosition/brand info appears; a "Váz"/frame row's free text may state the frame type or suspension). Extract from either source when the value is clearly and unambiguously present.\n` +
      `- When available, the user message also has a top-level "description" string — the listing's own marketing/product-description prose (distinct from a rawSpecs row's own per-row "description" field above). Treat it as LOWER confidence than rawSpecs or rawModel: it's unstructured sales copy, not a labeled spec table, so it can restate a spec correctly, omit it, or describe it only vaguely/figuratively. Only extract a value from it when a spec is clearly, specifically, and unambiguously stated (e.g. "a váz felső csövéből egyszerűen eltávolítható akkumulátor" clearly states batteryRemovable=true) — never from general marketing tone or a category/discipline claim alone (e.g. "versenyorientált fully kerékpár" praising a bike as competition-oriented does NOT by itself justify picking a specific usageType/frameType enum value unless that value is genuinely and specifically what the sentence describes). When rawSpecs/deterministicSpecs already has a value for a field, prefer it over anything implied by description.\n` +
      this.buildAllowedValuesRule() +
      unitRule +
      `- Only use evidence present in the input. Never invent or guess a spec value for a field the input doesn't support — omit the key entirely instead.\n` +
      `- Do not recompute or convert units the input didn't provide (e.g. don't derive torque from motor power).\n` +
      `- Return a single JSON object with a "specs" key only — new/corrected canonical fields only, never values already matching deterministicSpecs. Never return "brand"/"model" — those are not part of this response.`
    );
  }

  private buildModelSpecResponseSchema(
    schema: SpecDefinitionJsonSchema,
    outputKeys: string[],
  ): unknown {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        specs: {
          type: 'object',
          additionalProperties: false,
          properties: this.buildSchemaProperties(schema, outputKeys),
        },
      },
    };
  }

  // ─── Shared user-message + response-schema-property builders ───────────

  private buildUserMessage(
    data: { brand: string; model: string; specs: ProductSpecs },
    rawSpecs?: ScrapedProductSpec[],
    knownSpecs?: ProductSpecs,
    description?: string,
  ): string {
    const payload: Record<string, unknown> = {
      deterministicSpecs: data.specs,
      rawModel: data.model,
      brand: data.brand,
    };

    // Only unification receives this — the identity extraction's settled
    // values, as read-only context per buildModelSpecSystemPrompt's own
    // instructions. Passed in directly rather than picked from `data.specs`,
    // since `data.specs` here holds only unification's own fields — picking
    // from it would always yield {}.
    if (knownSpecs && !isEmpty(knownSpecs)) {
      payload['knownSpecs'] = knownSpecs;
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
    // includeDescriptionInOfferIdentity/includeDescriptionInModelSpecs).
    // Both prompts treat it as lower confidence than rawModel/rawSpecs, per
    // their own "description" rule.
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
