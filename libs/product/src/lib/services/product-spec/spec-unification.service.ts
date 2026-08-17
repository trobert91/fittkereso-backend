import { Injectable } from '@nestjs/common';
import { AiChatService } from '@fittkereso-backend/ai';
import type {
  ProductSpecs,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductSpecNormalizationService } from './product-spec-normalization.service';

const DEFAULT_MODEL = 'deepseek-v4-flash';

/**
 * Re-shapes a source's deterministically-extracted ProductSpecs into the
 * category's canonical key/value format via an LLM call, guided by the
 * category's JSON Schema plus one hand-picked "golden sample" product.
 *
 * Runs AFTER SpecExtractionService, not instead of it — the deterministic
 * pass already did unit stripping/number extraction/value remapping; this
 * pass only re-keys/re-shapes into the canonical field set for sources whose
 * raw labels don't line up with the category's SourceSpecMapping[] entries.
 *
 * Mirrors TranslationService's degrade-on-failure contract: any internal
 * error (LLM call failure, schema validation failure) is caught and the
 * caller gets `extractedSpecs` back unchanged, never a thrown error — a
 * failed unification pass should not fail the whole scrape.
 */
@Injectable()
export class SpecUnificationService {
  private readonly logger = new CustomLogger(SpecUnificationService.name);

  constructor(
    private readonly aiChat: AiChatService,
    private readonly specNormalizer: ProductSpecNormalizationService,
  ) {}

  async unify(params: {
    extractedSpecs: ProductSpecs;
    schema: SpecDefinitionJsonSchema;
    goldenSample: ProductSpecs;
    model?: string;
  }): Promise<ProductSpecs> {
    const { extractedSpecs, schema, goldenSample, model } = params;

    try {
      const response = await this.aiChat.createChat({
        costLabel: 'spec-unification',
        schema: this.buildResponseSchema(schema),
        schemaName: 'unified_specs',
        model: model ?? DEFAULT_MODEL,
        messages: [
          { role: 'system', content: this.buildSystemPrompt(schema, goldenSample) },
          { role: 'user', content: JSON.stringify(extractedSpecs) },
        ],
        temperature: 1,
      });

      const unified = response.parsed as ProductSpecs | undefined;
      if (!unified) {
        this.logger.warn('Spec unification returned no parsed output, falling back', {
          preview: response.content?.slice(0, 200),
        });
        return extractedSpecs;
      }

      return this.specNormalizer.normalize(unified, schema);
    } catch (error: unknown) {
      this.logger.warn('Spec unification LLM call failed, falling back to deterministic specs', {
        error: error instanceof Error ? error.message : String(error),
      });
      return extractedSpecs;
    }
  }

  private buildSystemPrompt(
    schema: SpecDefinitionJsonSchema,
    goldenSample: ProductSpecs,
  ): string {
    const fieldDescriptions = Object.entries(schema.properties)
      .map(([key, prop]) => {
        const unit = prop.meta?.unit ? `, unit: ${prop.meta.unit}` : '';
        const examples = prop.meta?.examples?.length
          ? `, examples: ${prop.meta.examples.join(', ')}`
          : '';
        return `- ${key} (${prop.type}${unit}${examples}): ${prop.title}`;
      })
      .join('\n');

    return (
      `You are normalizing product specifications for the "${schema.title}" category into a fixed canonical field set.\n\n` +
      `Canonical fields:\n${fieldDescriptions}\n\n` +
      `Worked example — a correctly unified output for this category:\n${JSON.stringify(goldenSample, null, 2)}\n\n` +
      `Rules:\n` +
      `- The user message is a source's already-extracted specs (raw labels/values from one retailer, not yet in canonical field names).\n` +
      `- Map each value to the matching canonical field above, converting units/formats to match the golden example's style.\n` +
      `- Only use evidence present in the input. Never invent or guess a value for a field the input doesn't support — omit the key entirely instead.\n` +
      `- Do not recompute or convert units the input didn't provide (e.g. don't derive torque from motor power).\n` +
      `- Return a single JSON object using only the canonical field names above.`
    );
  }

  /**
   * Wraps the category's SpecDefinitionJsonSchema properties as a strict
   * response schema (additionalProperties: false, no required keys — every
   * field is optional since a source may not expose all of them).
   */
  private buildResponseSchema(schema: SpecDefinitionJsonSchema): unknown {
    return {
      type: 'object',
      additionalProperties: false,
      properties: schema.properties,
    };
  }
}
