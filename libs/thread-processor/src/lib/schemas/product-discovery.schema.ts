import { z } from 'zod';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const DiscoveredSpecSchema = z.object({
  name: z
    .string()
    .describe(
      'Spec type key from the valid specs list (e.g. "refreshRate", "panelType")',
    ),
  value: z
    .string()
    .describe('The spec value as stated (e.g. "240Hz", "QD-OLED")'),
});

const DiscoveredProductSchema = z.object({
  brand: z
    .string()
    .describe('Brand name. Use cheat sheet canonical brand when available.'),
  model: z
    .string()
    .describe(
      'Model string. Empty "" when only a brand-level reference exists with no model token.',
    ),
  categoryHint: z
    .string()
    .optional()
    .describe(
      'General product category (e.g., "monitor", "headphones", "keyboard"). Required when the product is not already in the cheat sheet.',
    ),
  specs: z
    .array(DiscoveredSpecSchema)
    .optional()
    .describe(
      'Specs stated by ANY commenter for this product, pooled across all its mentions. Use ONLY spec names from the valid specs list. Omit if none stated.',
    ),
  referenceModel: z
    .string()
    .optional()
    .describe(
      'Catalog model token copied verbatim from the cheat sheet line (e.g. "34GS95QE-B") when this product is already in the cheat sheet. Never guess or invent — only copy from a line with a real catalog model (not lines tagged "(unresolved)").',
    ),
  modelClues: z
    .array(z.string())
    .optional()
    .describe(
      'Partial model codes or tokens users wrote that do not exactly match the cheat sheet (e.g. ["G8sd"]). Only set alongside referenceModel. Omit when model is set or no model token appears.',
    ),
  variantClues: z
    .array(z.string())
    .optional()
    .describe(
      'Free-form distinguishing traits that do not fit a structured spec name (e.g. ["full-size ports", "black remote", "Tizen OS"]). Use specs for traits with a structured spec equivalent.',
    ),
  contentQuality: z
    .enum(['high', 'medium', 'low'])
    .describe(
      'Best review quality across this product\'s mentions. high = substantive evaluation with specifics, comparison, or detailed experience; medium = verdict or preference without depth; low = named but not evaluated.',
    ),
  linkLabel: z
    .string()
    .describe(
      'Stable single-letter label (A, B, C, …) for this DISTINCT product. Reuse the SAME letter for the same exact product; use a NEW letter for a sibling/variant SKU. The comment-identification step references products by this label.',
    ),
});

export const ProductDiscoveryResponseSchema = z.object({
  products: z
    .array(DiscoveredProductSchema)
    .describe(
      'Every DISTINCT product discussed in this batch, with pooled identifying evidence. One entry per distinct product — NOT one per mention. Exclude products already present in the cheat sheet unless this batch adds new evidence; when re-surfacing a known product, reuse its canonical brand/model and set referenceModel.',
    ),
});

export type ProductDiscoveryLLMResponse = z.infer<
  typeof ProductDiscoveryResponseSchema
>;
export type LLMDiscoveredProduct = z.infer<typeof DiscoveredProductSchema>;

// ─── JSON Schema for OpenAI structured output ────────────────────────────────

export const PRODUCT_DISCOVERY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: {
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
          referenceModel: { type: 'string' },
          modelClues: { type: 'array', items: { type: 'string' } },
          variantClues: { type: 'array', items: { type: 'string' } },
          contentQuality: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
          },
          linkLabel: { type: 'string' },
        },
        required: ['brand', 'model', 'contentQuality', 'linkLabel'],
        additionalProperties: false,
      },
    },
  },
  required: ['products'],
  additionalProperties: false,
} as const;
