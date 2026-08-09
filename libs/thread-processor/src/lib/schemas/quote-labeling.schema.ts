import { z } from "zod";
import { Sentiment } from "@ebike-backend/database";

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const SENTIMENT_VALUES = Object.values(Sentiment) as string[];

const NEGATIVE_SENTIMENT_VALUES = [
  Sentiment.Negative,
  Sentiment.StrongNegative,
] as const;

const EvidenceSchema = z.object({
  label: z
    .string()
    .describe(
      "Feature or use case label. Use EXACT labels from the vocabulary.",
    ),
  sentiment: z
    .nativeEnum(Sentiment)
    .optional()
    .describe(
      "Per-label sentiment override. Omit when the quote's sentiment applies as-is; emit only when this label diverges (e.g. 'great screen but terrible stand' → stand: strongNegative).",
    ),
});

const IssueEvidenceSchema = z.object({
  label: z
    .string()
    .describe(
      "Closed-list issue label from the ISSUE LABELS vocabulary. The parent feature is mapped programmatically at scoring time — do not pick or emit the feature.",
    ),
  sentiment: z
    .enum(NEGATIVE_SENTIMENT_VALUES)
    .describe(
      "Severity of the issue. `negative` = notable but minor/intermittent; `strongNegative` = severe (defective unit, dealbreaker, return-worthy). Required.",
    ),
});

const QualitySchema = z
  .enum(["high", "medium", "low"])
  .describe(
    "Buyer-utility tier for this quote. high = first-hand experience with grounded evaluation; medium = informational (specs, citations, bare verdicts) without first-hand framing; low = no useful purchase information (bare acquisition, settings dumps, neutral logistics, pure brand trust, troubleshooting fragments out of context).",
  );

const LabeledQuoteSchema = z.object({
  quoteIndex: z
    .number()
    .describe("Zero-based index of this quote in the product's quotes array."),
  quality: QualitySchema,
  speculative: z
    .boolean()
    .optional()
    .describe(
      "Set to true when the WHOLE quote is hedged, hearsay, future-tense, or otherwise not a first-hand observation of what it describes. Omit when the quote reports a first-hand observation.",
    ),
  features: z
    .array(EvidenceSchema)
    .optional()
    .describe(
      "Feature-level evidence for this quote. Each entry: { label, sentiment? } where sentiment is omitted unless it diverges from the quote sentiment. Omit if no features apply.",
    ),
  useCases: z
    .array(EvidenceSchema)
    .optional()
    .describe(
      "Use-case-level evidence for this quote. Each entry: { label, sentiment? } where sentiment is omitted unless it diverges from the quote sentiment. Omit if no use cases apply.",
    ),
  issues: z
    .array(IssueEvidenceSchema)
    .optional()
    .describe(
      'Issue evidence by closed-list label. Each entry: { label, sentiment } where sentiment is "negative" (minor) or "strongNegative" (severe). The parent feature is mapped programmatically at scoring time. Omit if no closed-list symptom matches.',
    ),
});

const ReferenceDetailsSchema = z.object({
  returned: z
    .boolean()
    .optional()
    .describe("Product was returned by the commenter."),
  defective: z
    .boolean()
    .optional()
    .describe("Product had a defect (dead pixels, DOA, etc.)."),
  multipleUnits: z
    .boolean()
    .optional()
    .describe("Commenter tested/owned multiple units of this product."),
});

const ReferenceLabelsSchema = z.object({
  features: z
    .array(EvidenceSchema)
    .optional()
    .describe(
      "Reference-level feature evidence. Use ONLY for labels that summarise the WHOLE ref across quotes — i.e. claims that no single quote alone evidences. Do not duplicate quote-level labels here. Always confirmed (no speculative flag). Issue labels are not allowed at the reference level — emit those only via quote-level `issues`.",
    ),
  useCases: z
    .array(EvidenceSchema)
    .optional()
    .describe(
      'Reference-level use-case evidence. Canonical example is "dual use" — emit when one quote shows work usage and another shows gaming usage, but no single quote alone evidences both. Always confirmed.',
    ),
});

const LabeledProductSchema = z.object({
  productId: z
    .string()
    .describe(
      'Product ID exactly as shown in the input (e.g., "Aa", "Bb"). Copy verbatim.',
    ),
  quotes: z
    .array(LabeledQuoteSchema)
    .optional()
    .describe(
      "Evidence labels for each quote. Only include quotes that have features, useCases, or issues to label.",
    ),
  referenceLabels: ReferenceLabelsSchema.optional().describe(
    "Cross-quote evidence about the whole reference. Use sparingly — quote-level evidence is the default. See STEP 6 of the labeling prompt.",
  ),
  referenceDetails: ReferenceDetailsSchema.optional().describe(
    "Structured facts about the commenter's relationship to this product. Omit if no details are mentioned.",
  ),
});

export const LabelingResponseSchema = z.object({
  products: z
    .array(LabeledProductSchema)
    .describe(
      "Labeling results per product reference. Include ALL product references from the input.",
    ),
});

export type LabelingLLMResponse = z.infer<typeof LabelingResponseSchema>;
export type LLMLabeledProduct = z.infer<typeof LabeledProductSchema>;
export type LLMLabeledQuote = z.infer<typeof LabeledQuoteSchema>;
export type LLMEvidence = z.infer<typeof EvidenceSchema>;
export type LLMIssueEvidence = z.infer<typeof IssueEvidenceSchema>;
export type LLMReferenceDetails = z.infer<typeof ReferenceDetailsSchema>;
export type LLMReferenceLabels = z.infer<typeof ReferenceLabelsSchema>;

// ─── JSON Schema builder for OpenAI structured output ────────────────────────

/**
 * Build the labeling JSON schema. Feature and use-case evidence carry
 * `{label, sentiment?}` — sentiment is optional and only emitted when the
 * label's sentiment diverges from the quote's overall sentiment. Issue
 * evidence is its own peer collection on the quote with
 * `{label: enum, sentiment: 'negative' | 'strongNegative'}`, where the enum
 * is the active category's canonical issue labels and the sentiment carries
 * severity. The parent feature is mapped programmatically from
 * `IssueLabelConfig.feature` at scoring time, not at labeling time.
 *
 * `speculative` is set at the quote level (not per evidence) when the whole
 * quote is hedged/hearsay/future-tense.
 *
 * `referenceLabels` is an optional per-product block for cross-quote evidence
 * — labels that summarise the whole ref but cannot be attributed to a single
 * quote (e.g. "dual use" when work and gaming evidence live in separate
 * quotes). Always confirmed; no speculative flag at this level. See STEP 6
 * of the labeling prompt.
 *
 * Pass `getIssueLabels(category).map(l => l.label)`. When the list is empty,
 * the `issues` property is omitted entirely so the model can't emit one.
 *
 * Pass `expectedProductIds` (e.g. ["Aa", "Ab", "Ba"]) to constrain productId
 * to an enum, preventing the model from emitting display names instead.
 */
export function buildLabelingJsonSchema(
  allowedIssueTypes: string[],
  expectedProductIds?: string[],
) {
  const evidenceItem = {
    type: "object",
    properties: {
      label: { type: "string" },
      sentiment: { type: "string", enum: SENTIMENT_VALUES },
    },
    required: ["label"],
    additionalProperties: false,
  };

  const quoteProperties: Record<string, unknown> = {
    quoteIndex: { type: "number" },
    quality: { type: "string", enum: ["high", "medium", "low"] },
    speculative: { type: "boolean" },
    features: { type: "array", items: evidenceItem },
    useCases: { type: "array", items: evidenceItem },
  };

  if (allowedIssueTypes.length > 0) {
    quoteProperties["issues"] = {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", enum: allowedIssueTypes },
          sentiment: {
            type: "string",
            enum: [Sentiment.Negative, Sentiment.StrongNegative],
          },
        },
        required: ["label", "sentiment"],
        additionalProperties: false,
      },
    };
  }

  return {
    type: "object",
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          properties: {
            productId: expectedProductIds?.length
              ? {
                  type: "string",
                  enum: expectedProductIds,
                  description:
                    'Two-letter code from the input ref tag (e.g. "Aa", "Bb"). Copy exactly from the bracketed [..] tag — never use the product display name, brand, or model.',
                }
              : { type: "string" },
            quotes: {
              type: "array",
              items: {
                type: "object",
                properties: quoteProperties,
                required: ["quoteIndex", "quality"],
                additionalProperties: false,
              },
            },
            referenceLabels: {
              type: "object",
              properties: {
                features: { type: "array", items: evidenceItem },
                useCases: { type: "array", items: evidenceItem },
              },
              additionalProperties: false,
            },
            referenceDetails: {
              type: "object",
              properties: {
                returned: { type: "boolean" },
                defective: { type: "boolean" },
                multipleUnits: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
          required: ["productId"],
          additionalProperties: false,
        },
      },
    },
    required: ["products"],
    additionalProperties: false,
  } as const;
}
