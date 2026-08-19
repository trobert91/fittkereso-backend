import { Injectable } from '@nestjs/common';
import { AiChatService } from '@fittkereso-backend/ai';
import type {
  ProductSpecs,
  ScrapedProductSpec,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductSpecNormalizationService } from './product-spec-normalization.service';

const DEFAULT_MODEL = 'deepseek-v4-flash';

/** Deterministic, pre-LLM view of a scraped product. */
export interface DeterministicProductData {
  brand: string;
  model: string;
  specs: ProductSpecs;
  releaseYear?: number;
}

/**
 * What the LLM may confidently contribute — same shape as
 * DeterministicProductData, every field optional. Fields the LLM isn't
 * confident about are omitted rather than guessed.
 */
export interface LlmProductContribution {
  brand?: string;
  model?: string;
  specs?: ProductSpecs;
  releaseYear?: number;
}

export type ProductSourcePostProcessResult = LlmProductContribution;

/**
 * Post-processes a source's deterministically-extracted data via a single
 * LLM call, guided by the category's JSON Schema plus one hand-picked
 * "golden sample" product:
 *  - re-shapes ProductSpecs into the category's canonical key/value format
 *  - cleans the source's raw product title down to just the model name,
 *    stripping brand/marketing/color/gender/category boilerplate that some
 *    sources (e.g. speedbike.hu, whose ShopRenter.product.name is the full
 *    listing title) bake into the same field
 *  - optionally corrects brand/releaseYear when confidently derivable from
 *    the input
 *
 * Runs AFTER SpecExtractionService, not instead of it — the deterministic
 * pass already did unit stripping/number extraction/value remapping; this
 * pass only re-keys/re-shapes into the canonical field set for sources whose
 * raw labels don't line up with the category's SourceSpecMapping[] entries.
 *
 * Returns only what the LLM confidently contributed (or `undefined` on any
 * failure) — never a value pre-merged with deterministic data. Merging is
 * ProductSourcePostProcessMergeService's job, so "no LLM contribution" has
 * exactly one shape (`undefined`) regardless of why: disabled, no golden
 * sample, thrown error, or an empty parsed response. Mirrors
 * TranslationService's degrade-on-failure contract: any internal error (LLM
 * call failure, schema validation failure) is caught and never thrown — a
 * failed post-process pass should not fail the whole scrape.
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

  async process(params: {
    data: DeterministicProductData;
    rawSpecs?: ScrapedProductSpec[];
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    model?: string;
    offerLevelSpecs?: string[];
  }): Promise<ProductSourcePostProcessResult | undefined> {
    const { data, rawSpecs, schema, goldenSample, model, offerLevelSpecs } =
      params;

    try {
      const response = await this.aiChat.createChat({
        costLabel: 'product-source-post-process',
        schema: this.buildResponseSchema(schema),
        schemaName: 'post_processed_product',
        model: model ?? DEFAULT_MODEL,
        messages: [
          {
            role: 'system',
            content: this.buildSystemPrompt(
              schema,
              goldenSample,
              offerLevelSpecs ?? [],
            ),
          },
          {
            role: 'user',
            content: this.buildUserMessage(data, rawSpecs),
          },
        ],
        temperature: 1,
      });

      const parsed = response.parsed as LlmProductContribution | undefined;
      if (!parsed) {
        this.logger.warn(
          'Post-process returned no usable output, degrading to deterministic-only',
          { preview: response.content?.slice(0, 200) },
        );
        return undefined;
      }

      const sanitized: LlmProductContribution = {
        brand: parsed.brand?.trim() || undefined,
        model: parsed.model?.trim() || undefined,
        specs: parsed.specs
          ? this.specNormalizer.normalize(parsed.specs, schema)
          : undefined,
        releaseYear: parsed.releaseYear,
      };

      if (
        sanitized.brand === undefined &&
        sanitized.model === undefined &&
        sanitized.specs === undefined &&
        sanitized.releaseYear === undefined
      ) {
        this.logger.warn(
          'Post-process contributed nothing usable after sanitization, degrading to deterministic-only',
          { preview: response.content?.slice(0, 200) },
        );
        return undefined;
      }

      return sanitized;
    } catch (error: unknown) {
      this.logger.warn(
        'Post-process LLM call failed, degrading to deterministic-only',
        { error: error instanceof Error ? error.message : String(error) },
      );
      return undefined;
    }
  }

  private buildSystemPrompt(
    schema: SpecDefinitionJsonSchema,
    goldenSample: ProductSpecs,
    offerLevelSpecs: string[],
  ): string {
    const fieldDescriptions = Object.entries(schema.properties)
      .map(([key, prop]) => {
        const unit = prop.meta?.unit ? `, unit: ${prop.meta.unit}` : '';
        const options = prop.meta?.options?.length
          ? `, allowed values (pick exactly one of these, verbatim): ${prop.meta.options.join(' | ')}`
          : '';
        const examples =
          !options && prop.meta?.examples?.length
            ? `, examples: ${prop.meta.examples.join(', ')}`
            : '';
        return `- ${key} (${prop.type}${unit}${options}${examples}): ${prop.title}`;
      })
      .join('\n');

    const offerLevelTitles = offerLevelSpecs
      .map((key) => schema.properties[key]?.title)
      .filter((title): title is string => Boolean(title));
    const offerLevelHint = offerLevelTitles.length
      ? ` Pay particular attention to ${offerLevelTitles.join(', ')} — these are frequently embedded only in the raw title/model text (e.g. a size code like "M/43" or a color name) rather than the structured spec table, and must be extracted from there if present.`
      : '';

    return (
      `You are normalizing product data for the "${schema.title}" category into a fixed canonical shape. The target audience is Hungarian — canonical spec field NAMES stay in English exactly as given below, but all string spec VALUES must be in Hungarian (translate if the source data is in another language, e.g. English or German). The "model" field should stay in whatever language the source uses for model names — do not translate it.\n\n` +
      `Canonical spec fields:\n${fieldDescriptions}\n\n` +
      `Worked example — a correctly unified specs output for this category:\n${JSON.stringify(goldenSample, null, 2)}\n\n` +
      `The user message has a "data" object with the already-known "brand", a "model" field (the source's raw, uncleaned model/title text — also referred to below as "rawModel"), "specs" (already deterministically mapped), and an optional "releaseYear". You may return any of "brand", "model", "specs", "releaseYear" in your response — but only the ones you can confidently produce. Omit any field entirely rather than guessing.\n\n` +
      `Field-specific guidance:\n` +
      `- "model": strip the brand (it's already given separately, don't repeat it), marketing/category boilerplate (e.g. a bike's usage type or "electric bicycle" wording), color names, size/dimension tokens, gender/target-audience words, and year — but first check whether any of these values are new information not already captured in "specs" (e.g. a frame size or color that only appears in the raw title). If so, add them to "specs" under the matching canonical field BEFORE removing them from "model" — the raw title is often the only place such a value appears at all, so stripping it without first extracting it destroys the information rather than just cleaning the name. KEEP genuine model designation tokens (line name, numeric/alphanumeric variant codes, edition names like "Di2", "SX", "Prestige"). If the given model text is already clean, return it unchanged. Never invent a model name that isn't derivable from the input.\n` +
      `- "brand": only return this if you can confidently correct or normalize the given brand (e.g. fixing inconsistent casing or a misspelling) based on evidence in the input — never invent or guess a different brand.\n` +
      `- "releaseYear": only return this if a release/model year is explicitly stated somewhere in the input (deterministicSpecs or rawSpecs) — the given deterministic value, if any, is often already reliable, so do not recompute or guess one from unrelated context (e.g. don't infer it from a model name).\n` +
      `- "specs": see the rules below.\n\n` +
      `Rules:\n` +
      `- The user message has a "deterministicSpecs" object (already mapped to canonical field names by a label-matching pass), a "rawModel" string (the same raw title referenced above), and, when available, a "rawSpecs" array — the source's full, unmapped spec table (label/value rows exactly as scraped, sometimes grouped under a "section", sometimes a free-text "description" instead of a single value).\n` +
      `- Start from deterministicSpecs — those values are already correct (though possibly not yet translated to Hungarian — translate them), keep them unless rawSpecs or rawModel gives a more precise value for the same field.\n` +
      `- Then look through rawSpecs AND rawModel for canonical spec fields deterministicSpecs is missing. A source may not have a row labeled like the canonical field at all — the value can be embedded inside a free-text component description (e.g. a row named "Motor" with value "Bosch PERFORMANCE SX BDU3144" may be the only place motorPower/motorPosition/brand info appears; a "Váz"/frame row's free text may state the frame type or suspension) or inside the raw title itself (e.g. a size code or color word mixed into the product name).${offerLevelHint} Extract from either source when the value is clearly and unambiguously present.\n` +
      `- For a spec field with "allowed values" listed above, you MUST output one of those exact Hungarian strings — pick the closest semantic match to the source value, never invent a new label or leave the source-language value untranslated.\n` +
      `- Convert spec units/formats to match the golden example's style.\n` +
      `- Only use evidence present in the input. Never invent or guess a spec value for a field the input doesn't support — omit the key entirely instead.\n` +
      `- Do not recompute or convert units the input didn't provide (e.g. don't derive torque from motor power).\n` +
      `- Return a single JSON object with a "specs" key (canonical field names, confidently-known ones only — omit fields you're unsure of) and optional "brand"/"model"/"releaseYear" keys per the field-specific guidance above.`
    );
  }

  private buildUserMessage(
    data: DeterministicProductData,
    rawSpecs: ScrapedProductSpec[] | undefined,
  ): string {
    const payload: Record<string, unknown> = {
      deterministicSpecs: data.specs,
      rawModel: data.model,
      brand: data.brand,
      releaseYear: data.releaseYear,
    };

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
   * Builds a strict-mode-valid JSON Schema for the response — a "specs"
   * object (derived from the category's SpecDefinitionJsonSchema properties)
   * plus optional "brand"/"model"/"releaseYear" fields. No `required` array
   * anywhere (top level or inside "specs") — the LLM should only populate
   * fields it's confident about; every field is optional.
   *
   * Cannot pass `schema.properties` straight through: SpecDefinitionProperty
   * carries a `meta` key (unit/examples/options/order — our own convention,
   * read by buildSystemPrompt) and a `title`, neither of which are schema
   * keywords. Ajv's `strict: true` mode (used by AiSchemaValidatorService)
   * rejects unknown keywords outright, so passing them through fails
   * `ajv.compile(schema)` before the LLM call is even validated.
   */
  private buildResponseSchema(schema: SpecDefinitionJsonSchema): unknown {
    const properties: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.type === 'array') {
        properties[key] = { type: 'array', items: { type: 'string' } };
      } else if (prop.type === 'string' && prop.meta?.options?.length) {
        properties[key] = { type: 'string', enum: prop.meta.options };
      } else {
        properties[key] = { type: prop.type };
      }
    }

    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        brand: { type: 'string' },
        model: { type: 'string' },
        releaseYear: { type: 'number' },
        specs: {
          type: 'object',
          additionalProperties: false,
          properties,
        },
      },
    };
  }
}
