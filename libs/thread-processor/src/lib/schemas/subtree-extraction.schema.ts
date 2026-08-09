import { z } from "zod";
import {
  Depth,
  ExperienceType,
  Intent,
  Sentiment,
} from "@ebike-backend/database";

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const SENTIMENT_VALUES = Object.values(Sentiment) as string[];

const SentimentSchema = z
  .nativeEnum(Sentiment)
  .describe("Net sentiment toward this specific product");

const QuoteSentimentSchema = z
  .nativeEnum(Sentiment)
  .describe("Sentiment of this specific quote");

const ExperienceSchema = z
  .nativeEnum(ExperienceType)
  .describe("Author's relationship to this product.");

const DepthSchema = z
  .nativeEnum(Depth)
  .describe("How substantive is the content about this product?");

const QuoteSchema = z.object({
  text: z
    .string()
    .describe(
      "Verbatim substring from the comment body. Must pass indexOf() check against the source.",
    ),
  sentiment: QuoteSentimentSchema,
  features: z
    .array(z.string())
    .optional()
    .describe(
      "Feature labels this quote directly supports or criticizes. Use EXACT strings from the Feature labels list. Omit if general.",
    ),
});

const IntentSchema = z
  .nativeEnum(Intent)
  .describe("What the author is communicating about this product");

const ExtractedSpecSchema = z.object({
  name: z
    .string()
    .describe(
      'Spec type key from the valid specs list (e.g. "refreshRate", "panelType")',
    ),
  value: z
    .string()
    .describe('The spec value as stated (e.g. "240Hz", "QD-OLED")'),
});

const ExtractedProductSchema = z.object({
  productIndex: z
    .number()
    .describe(
      "Zero-based index referencing the resolved product list for this comment (p0, p1, ...). Must match exactly.",
    ),
  specs: z
    .array(ExtractedSpecSchema)
    .optional()
    .describe(
      "Specs explicitly stated in this comment for this product. Use ONLY spec names from the valid specs list. Omit if no specs mentioned.",
    ),
  quotes: z
    .array(QuoteSchema)
    .optional()
    .describe(
      "Verbatim quotes from this comment about this product. Max 8. Omit if no useful quotes.",
    ),
  experience: ExperienceSchema,
  depth: DepthSchema,
  intents: z
    .array(IntentSchema)
    .describe(
      'One or two intents behind this product mention. E.g. ["recommendation", "comparison"]. Max 2. Empty array when none apply.',
    ),
  overallSentiment: SentimentSchema.describe(
    "Net overall sentiment across all quotes and statements about this product",
  ),
});

const CommentExtractionSchema = z.object({
  commentId: z
    .string()
    .describe(
      "Short ID exactly as shown in the prompt (c0, c1, ...). Never hallucinate IDs.",
    ),
  products: z
    .array(ExtractedProductSchema)
    .describe(
      "Extraction results for each pre-identified product in this comment. Must match the product indices from the resolved products section.",
    ),
});

export const ExtractionResponseSchema = z.object({
  comments: z
    .array(CommentExtractionSchema)
    .describe(
      "One entry per [PLAN] comment. Must include ALL [PLAN] comment IDs — missing entries trigger a retry.",
    ),
});

export type ExtractionLLMResponse = z.infer<typeof ExtractionResponseSchema>;
export type LLMExtractedComment = z.infer<typeof CommentExtractionSchema>;
export type LLMExtractedProduct = z.infer<typeof ExtractedProductSchema>;
export type LLMExtractedSpec = z.infer<typeof ExtractedSpecSchema>;
export type LLMQuote = z.infer<typeof QuoteSchema>;

// ─── JSON Schema for OpenAI structured output ────────────────────────────────

export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          commentId: { type: "string" },
          products: {
            type: "array",
            items: {
              type: "object",
              properties: {
                productIndex: { type: "number" },
                specs: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      value: { type: "string" },
                    },
                    required: ["name", "value"],
                    additionalProperties: false,
                  },
                },
                quotes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      sentiment: {
                        type: "string",
                        enum: SENTIMENT_VALUES,
                      },
                      features: { type: "array", items: { type: "string" } },
                    },
                    required: ["text", "sentiment"],
                    additionalProperties: false,
                  },
                },
                experience: {
                  type: "string",
                  enum: [
                    "owner",
                    "prior_owner",
                    "tested",
                    "prospective_buyer",
                    "reference",
                  ],
                },
                depth: {
                  type: "string",
                  enum: [
                    "comprehensive",
                    "detailed",
                    "mentioned",
                    "superficial",
                  ],
                },
                intents: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: [
                      "recommendation",
                      "issue_report",
                      "comparison",
                      "experience_report",
                      "warning",
                      "seeking_advice",
                      "question",
                      "reputation_report",
                    ],
                  },
                },
                overallSentiment: {
                  type: "string",
                  enum: SENTIMENT_VALUES,
                },
              },
              required: [
                "productIndex",
                "experience",
                "depth",
                "intents",
                "overallSentiment",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["commentId", "products"],
        additionalProperties: false,
      },
    },
  },
  required: ["comments"],
  additionalProperties: false,
} as const;
