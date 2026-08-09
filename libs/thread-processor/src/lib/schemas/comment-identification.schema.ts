import { z } from 'zod';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const IdentifiedSpecSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const MappedProductRefSchema = z.object({
  type: z
    .enum(['explicit', 'referenced'])
    .describe(
      'Set to "referenced" when the comment refers back to a product without adding new identification info (a bare callback like "I love mine", "same as yours"). Set to "explicit" when the comment names the product directly or adds a model number / spec / disambiguating descriptor.',
    ),
  linkLabel: z
    .string()
    .optional()
    .describe(
      'The DISCOVERED product this comment references — its letter from the resolved-products list (A, B, C, …). Set this when the comment references one of the already-resolved products. Omit ONLY when the product is genuinely new and absent from that list (then fill the `new` block instead).',
    ),
  new: z
    .object({
      brand: z.string(),
      model: z
        .string()
        .describe('Model string, or "" for a brand-only mention.'),
      categoryHint: z.string().optional(),
      specs: z.array(IdentifiedSpecSchema).optional(),
      modelClues: z.array(z.string()).optional(),
      variantClues: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      'A product the discovery sweep MISSED — set ONLY when no resolved-products letter fits. Provide enough to resolve it (brand, model or clues, categoryHint). Leave unset when linkLabel is set.',
    ),
  contentQuality: z
    .enum(['high', 'medium', 'low'])
    .describe(
      'Review quality of THIS comment for THIS product. high = substantive evaluation; medium = verdict without depth; low = named but not evaluated.',
    ),
});

const CommentMappingSchema = z.object({
  commentId: z
    .string()
    .describe(
      'Short ID exactly as shown in the prompt (c0, c1, ...). Never hallucinate IDs.',
    ),
  products: z
    .array(MappedProductRefSchema)
    .describe(
      'Products this comment references — 0, 1, or many. Empty array = no buyer-relevant product reference. Each entry sets EITHER linkLabel (a resolved product) OR new (a missed product).',
    ),
});

export const CommentIdentificationResponseSchema = z.object({
  comments: z
    .array(CommentMappingSchema)
    .describe(
      'One entry per [PLAN] comment. Must include ALL [PLAN] comment IDs.',
    ),
});

export type CommentIdentificationLLMResponse = z.infer<
  typeof CommentIdentificationResponseSchema
>;
export type LLMMappedProductRef = z.infer<typeof MappedProductRefSchema>;

// ─── JSON Schema for OpenAI structured output ────────────────────────────────

export const COMMENT_IDENTIFICATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          commentId: { type: 'string' },
          products: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['explicit', 'referenced'] },
                linkLabel: { type: 'string' },
                new: {
                  type: 'object',
                  properties: {
                    brand: { type: 'string' },
                    model: { type: 'string' },
                    categoryHint: { type: 'string' },
                    specs: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          value: { type: 'string' },
                        },
                        required: ['name', 'value'],
                        additionalProperties: false,
                      },
                    },
                    modelClues: { type: 'array', items: { type: 'string' } },
                    variantClues: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['brand', 'model'],
                  additionalProperties: false,
                },
                contentQuality: {
                  type: 'string',
                  enum: ['high', 'medium', 'low'],
                },
              },
              required: ['type', 'contentQuality'],
              additionalProperties: false,
            },
          },
        },
        required: ['commentId', 'products'],
        additionalProperties: false,
      },
    },
  },
  required: ['comments'],
  additionalProperties: false,
} as const;
