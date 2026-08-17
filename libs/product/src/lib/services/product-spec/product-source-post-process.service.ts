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

export interface ProductSourcePostProcessResult {
  specs: ProductSpecs;
  model?: string;
}

/**
 * Post-processes a source's deterministically-extracted data via a single
 * LLM call, guided by the category's JSON Schema plus one hand-picked
 * "golden sample" product:
 *  - re-shapes ProductSpecs into the category's canonical key/value format
 *  - cleans the source's raw product title down to just the model name,
 *    stripping brand/marketing/color/gender/category boilerplate that some
 *    sources (e.g. speedbike.hu, whose ShopRenter.product.name is the full
 *    listing title) bake into the same field
 *
 * Runs AFTER SpecExtractionService, not instead of it — the deterministic
 * pass already did unit stripping/number extraction/value remapping; this
 * pass only re-keys/re-shapes into the canonical field set for sources whose
 * raw labels don't line up with the category's SourceSpecMapping[] entries,
 * and only cleans the model name for sources whose raw title field isn't
 * already a clean model name.
 *
 * Mirrors TranslationService's degrade-on-failure contract: any internal
 * error (LLM call failure, schema validation failure) is caught and the
 * caller gets `extractedSpecs`/`rawModel` back unchanged, never a thrown
 * error — a failed post-process pass should not fail the whole scrape.
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
    extractedSpecs: ProductSpecs;
    rawSpecs?: ScrapedProductSpec[];
    rawModel?: string;
    brand?: string;
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    model?: string;
  }): Promise<ProductSourcePostProcessResult> {
    const { extractedSpecs, rawSpecs, rawModel, brand, schema, goldenSample, model } =
      params;
    const fallback: ProductSourcePostProcessResult = {
      specs: extractedSpecs,
      model: rawModel,
    };

    try {
      const response = await this.aiChat.createChat({
        costLabel: 'product-source-post-process',
        schema: this.buildResponseSchema(schema),
        schemaName: 'post_processed_product',
        model: model ?? DEFAULT_MODEL,
        messages: [
          {
            role: 'system',
            content: this.buildSystemPrompt(schema, goldenSample, !!rawModel),
          },
          {
            role: 'user',
            content: this.buildUserMessage(extractedSpecs, rawSpecs, rawModel, brand),
          },
        ],
        temperature: 1,
      });

      const parsed = response.parsed as
        | { specs?: ProductSpecs; model?: string }
        | undefined;
      if (!parsed) {
        this.logger.warn('Post-process returned no parsed output, falling back', {
          preview: response.content?.slice(0, 200),
        });
        return fallback;
      }

      return {
        specs: parsed.specs
          ? this.specNormalizer.normalize(parsed.specs, schema)
          : extractedSpecs,
        model: parsed.model?.trim() || rawModel,
      };
    } catch (error: unknown) {
      this.logger.warn('Post-process LLM call failed, falling back to deterministic data', {
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  private buildSystemPrompt(
    schema: SpecDefinitionJsonSchema,
    goldenSample: ProductSpecs,
    includeModelCleanup: boolean,
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

    const modelInstructions = includeModelCleanup
      ? `\n\nThe user message also has a "rawModel" string (the source's raw, uncleaned model/title field) and a "brand" string (the product's already-known, correct brand name). Return a "model" field: the clean model name only — strip the brand (it's already given separately, don't repeat it), marketing/category boilerplate (e.g. a bike's usage type or "electric bicycle" wording), color names, gender/target-audience words, and year, but KEEP genuine model designation tokens (line name, numeric/alphanumeric variant codes, edition names like "Di2", "SX", "Prestige"). If rawModel is already a clean model name with nothing to strip, return it unchanged. Never invent a model name that isn't derivable from rawModel.`
      : '';

    return (
      `You are normalizing product data for the "${schema.title}" category into a fixed canonical shape. The target audience is Hungarian — canonical spec field NAMES stay in English exactly as given below, but all string spec VALUES must be in Hungarian (translate if the source data is in another language, e.g. English or German). The "model" field (if requested) should stay in whatever language the source uses for model names — do not translate it.\n\n` +
      `Canonical spec fields:\n${fieldDescriptions}\n\n` +
      `Worked example — a correctly unified specs output for this category:\n${JSON.stringify(goldenSample, null, 2)}${modelInstructions}\n\n` +
      `Rules:\n` +
      `- The user message has a "deterministicSpecs" object (already mapped to canonical field names by a label-matching pass) and, when available, a "rawSpecs" array — the source's full, unmapped spec table (label/value rows exactly as scraped, sometimes grouped under a "section", sometimes a free-text "description" instead of a single value).\n` +
      `- Start from deterministicSpecs — those values are already correct (though possibly not yet translated to Hungarian — translate them), keep them unless rawSpecs gives a more precise value for the same field.\n` +
      `- Then look through rawSpecs for canonical spec fields deterministicSpecs is missing. A source may not have a row labeled like the canonical field at all — the value can be embedded inside a free-text component description (e.g. a row named "Motor" with value "Bosch PERFORMANCE SX BDU3144" may be the only place motorPower/motorPosition/brand info appears; a "Váz"/frame row's free text may state the frame type or suspension). Extract it from there when it's clearly and unambiguously present.\n` +
      `- For a spec field with "allowed values" listed above, you MUST output one of those exact Hungarian strings — pick the closest semantic match to the source value, never invent a new label or leave the source-language value untranslated.\n` +
      `- Convert spec units/formats to match the golden example's style.\n` +
      `- Only use evidence present in the input. Never invent or guess a spec value for a field the input doesn't support — omit the key entirely instead.\n` +
      `- Do not recompute or convert units the input didn't provide (e.g. don't derive torque from motor power).\n` +
      `- Return a single JSON object with a "specs" key (canonical field names only) ${includeModelCleanup ? 'and a "model" key' : ''}.`
    );
  }

  private buildUserMessage(
    extractedSpecs: ProductSpecs,
    rawSpecs: ScrapedProductSpec[] | undefined,
    rawModel: string | undefined,
    brand: string | undefined,
  ): string {
    const payload: Record<string, unknown> = {
      deterministicSpecs: extractedSpecs,
    };

    if (rawSpecs?.length) {
      payload['rawSpecs'] = rawSpecs.map((spec) => ({
        name: spec.name,
        ...(spec.sectionTitle ? { section: spec.sectionTitle } : {}),
        ...(spec.description ? { description: spec.description } : {}),
        ...(spec.values ? { values: spec.values } : {}),
      }));
    }

    if (rawModel) {
      payload['rawModel'] = rawModel;
      payload['brand'] = brand;
    }

    return JSON.stringify(payload);
  }

  /**
   * Builds a strict-mode-valid JSON Schema for the response — a "specs"
   * object (derived from the category's SpecDefinitionJsonSchema properties,
   * additionalProperties: false, no required keys — every field is optional
   * since a source may not expose all of them) plus an optional "model"
   * string.
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
        specs: {
          type: 'object',
          additionalProperties: false,
          properties,
        },
        model: { type: 'string' },
      },
    };
  }
}
