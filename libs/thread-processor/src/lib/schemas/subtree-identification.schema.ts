import { z } from 'zod';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const MappedSpecSchema = z.object({
  name: z
    .string()
    .describe(
      'Spec type key from the valid specs list (e.g. "refreshRate", "panelType")',
    ),
  value: z
    .string()
    .describe('The spec value as stated (e.g. "240Hz", "QD-OLED")'),
});

const MappedProductSchema = z.object({
  type: z
    .enum(['explicit', 'referenced'])
    .describe(
      'Set to "referenced" when the comment refers back to a product mentioned earlier in this conversation WITHOUT adding new identification info (specs, version, model number, disambiguating descriptor). Use the same brand/model as shown in the cheat sheet. Set to "explicit" when the comment introduces a new product OR provides identification info that may clarify which version is meant (e.g. "the Pro version", "the smaller one", a specific model number, distinctive specs).',
    ),
  brand: z
    .string()
    .describe(
      'Brand name. Use cheat sheet canonical brand when available.',
    ),
  model: z
    .string()
    .describe(
      'Model string. Empty "" for purely implicit brand-only references.',
    ),
  categoryHint: z
    .string()
    .optional()
    .describe(
      'General product category (e.g., "monitor", "headphones", "keyboard"). Required when the product is not in the cheat sheet.',
    ),
  specs: z
    .array(MappedSpecSchema)
    .optional()
    .describe(
      'Specs explicitly stated by the commenter for this product. Use ONLY spec names from the valid specs list. Omit if no specs mentioned.',
    ),
  referenceModel: z
    .string()
    .optional()
    .describe(
      'Catalog model token copied verbatim from the cheat sheet line (e.g. "34GS95QE-B"). Set when the comment refers to a product already in the cheat sheet. Never guess or invent — only copy from a line with a real catalog model (not lines tagged "(unresolved)").',
    ),
  modelClues: z
    .array(z.string())
    .optional()
    .describe(
      'Partial model codes or tokens the user wrote that do not exactly match the cheat sheet (e.g. ["G8sd"]). Only set when referenceModel is set. Omit when model is set or when no model token appears in the comment.',
    ),
  variantClues: z
    .array(z.string())
    .optional()
    .describe(
      'Free-form distinguishing traits that do not fit a structured spec name (e.g. ["full-size ports", "black remote", "Tizen OS"]). Only set when referenceModel is set. Use specs for traits with a structured spec equivalent (screenSize, refreshRate, panelType, curvature, etc.).',
    ),
  contentQuality: z
    .enum(['high', 'medium', 'low'])
    .describe(
      'high = substantive evaluation with specifics, comparison, or detailed experience; medium = verdict or preference without depth (e.g. "it\'s great", "solid monitor"); low = product named but not evaluated (bare ownership, listing, availability question)',
    ),
  linkId: z
    .string()
    .describe(
      'Same-product group label. Use a single letter (A, B, C, …). Give EVERY mention of the same EXACT product the same letter across all comments in this response — including bare back-references ("the LG"). Use a NEW letter for a different product or a sibling/variant SKU.',
    ),
});

const CommentIdentificationSchema = z.object({
  commentId: z
    .string()
    .describe(
      'Short ID exactly as shown in the prompt (c0, c1, ...). Never hallucinate IDs.',
    ),
  products: z
    .array(MappedProductSchema)
    .describe(
      'Products with buyer-relevant content in this comment. Empty array = no product references or no buyer-relevant content.',
    ),
});

export const IdentificationResponseSchema = z.object({
  comments: z
    .array(CommentIdentificationSchema)
    .describe(
      'One entry per [PLAN] comment. Must include ALL [PLAN] comment IDs.',
    ),
});

export type IdentificationLLMResponse = z.infer<
  typeof IdentificationResponseSchema
>;
export type LLMMappedProduct = z.infer<typeof MappedProductSchema>;

// ─── JSON Schema for OpenAI structured output ────────────────────────────────

export const IDENTIFICATION_JSON_SCHEMA = {
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
                referenceModel: { type: 'string' },
                modelClues: { type: 'array', items: { type: 'string' } },
                variantClues: { type: 'array', items: { type: 'string' } },
                contentQuality: {
                  type: 'string',
                  enum: ['high', 'medium', 'low'],
                },
                linkId: { type: 'string' },
              },
              required: ['type', 'brand', 'model', 'contentQuality', 'linkId'],
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
