import { z } from 'zod';

const LabelNarrativeSchema = z.object({
  name: z
    .string()
    .describe('Label name from the supplied vocabulary — copy verbatim.'),
  headline: z
    .string()
    .describe(
      'Opinionated sentence (≤12 words). Do NOT just restate the label name. Surface the consensus verdict.',
    ),
  narrative: z
    .string()
    .describe(
      'One to three sentences grounding the consensus across the supplied sentiment counts and evidence quotes.',
    ),
});

const ProConSchema = z.object({
  text: z
    .string()
    .describe('Short string (≤14 words) — the strength or downside.'),
  quoteIds: z
    .array(z.string())
    .describe(
      'Up to 3 supporting quote IDs (e.g. "q3", "q7") copied verbatim from the LABELS TO ANALYZE evidence block. ' +
        'Use only IDs that actually appear in the prompt. Prefer to cite at least one; an empty array is acceptable only if no quote in the evidence supports this point.',
    ),
});

export const ProductReviewAnalysisResponseSchema = z.object({
  tldr: z
    .string()
    .describe(
      'One-line headline (≤25 words) capturing the product identity + 1-2 strongest pros + 1 prominent issue.',
    ),
  summary: z
    .string()
    .describe(
      '2-4 sentence product overview: what the product is, who it is for, what differentiates it. Do NOT enumerate pros/cons here.',
    ),
  pros: z
    .array(ProConSchema)
    .describe(
      "3-6 entries in priority order — the product's biggest strengths, grounded in the supplied per-label evidence.",
    ),
  cons: z
    .array(ProConSchema)
    .describe(
      "3-6 entries in priority order — the product's most prominent downsides, grounded in the supplied per-label evidence.",
    ),
  featureLabels: z
    .array(LabelNarrativeSchema)
    .describe('Per-feature headline + narrative. Include one entry per supplied feature label.'),
  useCaseLabels: z
    .array(LabelNarrativeSchema)
    .describe('Per-use-case headline + narrative. Include one entry per supplied use-case label.'),
  issueLabels: z
    .array(LabelNarrativeSchema)
    .describe('Per-issue headline + narrative. Include one entry per supplied issue label.'),
});

export type ProductReviewAnalysisResponse = z.infer<typeof ProductReviewAnalysisResponseSchema>;
export type ProductReviewAnalysisLabelNarrative = z.infer<typeof LabelNarrativeSchema>;
export type ProductReviewAnalysisProCon = z.infer<typeof ProConSchema>;

export interface ProductReviewAnalysisAllowedLabels {
  features: string[];
  useCases: string[];
  issues: string[];
}

export function buildProductReviewAnalysisJsonSchema(
  allowed: ProductReviewAnalysisAllowedLabels,
) {
  const labelArray = (allowedNames: string[]) => ({
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'headline', 'narrative'],
      properties: {
        name: allowedNames.length
          ? { type: 'string', enum: allowedNames }
          : { type: 'string' },
        headline: { type: 'string' },
        narrative: { type: 'string' },
      },
    },
  });

  const proConArray = {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'quoteIds'],
      properties: {
        text: { type: 'string' },
        quoteIds: { type: 'array', items: { type: 'string' } },
      },
    },
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['tldr', 'summary', 'pros', 'cons', 'featureLabels', 'useCaseLabels', 'issueLabels'],
    properties: {
      tldr: { type: 'string' },
      summary: { type: 'string' },
      pros: proConArray,
      cons: proConArray,
      featureLabels: labelArray(allowed.features),
      useCaseLabels: labelArray(allowed.useCases),
      issueLabels: labelArray(allowed.issues),
    },
  } as const;
}
