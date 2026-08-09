import { z } from "zod";
import { Sentiment } from "@ebike-backend/database";
import { LLM_EMITTABLE_TYPES } from "../services/validation/validation-issue-types";

const SENTIMENT_VALUES = Object.values(Sentiment) as [string, ...string[]];
const EXPERIENCE_VALUES = [
  "owner",
  "prior_owner",
  "tested",
  "prospective_buyer",
  "reference",
] as const;
const DEPTH_VALUES = [
  "comprehensive",
  "detailed",
  "mentioned",
  "superficial",
] as const;
const INTENT_VALUES = [
  "recommendation",
  "issue_report",
  "comparison",
  "experience_report",
  "warning",
  "seeking_advice",
  "question",
  "reputation_report",
] as const;

const QUALITY_VALUES = ["high", "medium", "low"] as const;
const COMMENT_STATUS_SUGGESTIONS = ["in_review", "deleted"] as const;

export const LlmEmittedIssueSchema = z.object({
  type: z.enum(LLM_EMITTABLE_TYPES as [string, ...string[]]),
  reasoning: z.string(),
  quoteId: z.string().optional(),
  suggestedSentiment: z.enum(SENTIMENT_VALUES).optional(),
  suggestedExperience: z.enum(EXPERIENCE_VALUES).optional(),
  suggestedDepth: z.enum(DEPTH_VALUES).optional(),
  suggestedIntents: z.array(z.enum(INTENT_VALUES)).optional(),
  suggestedSpeculative: z.boolean().optional(),
  suggestedQuality: z.enum(QUALITY_VALUES).optional(),
});

export const LlmEmittedRefSchema = z.object({
  refLabel: z.string(),
  issues: z.array(LlmEmittedIssueSchema),
});

export const LlmEmittedCommentReviewSchema = z.object({
  commentLabel: z.string(),
  suggestedStatus: z.enum(COMMENT_STATUS_SUGGESTIONS).optional(),
  reviewComment: z.string(),
});

export const LlmValidationResponseSchema = z.object({
  refs: z.array(LlmEmittedRefSchema),
  commentReviews: z.array(LlmEmittedCommentReviewSchema).optional(),
});

export type LlmEmittedIssue = z.infer<typeof LlmEmittedIssueSchema>;
export type LlmEmittedRef = z.infer<typeof LlmEmittedRefSchema>;
export type LlmEmittedCommentReview = z.infer<
  typeof LlmEmittedCommentReviewSchema
>;
export type LlmValidationResponse = z.infer<typeof LlmValidationResponseSchema>;

export const LLM_VALIDATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["refs"],
  properties: {
    refs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["refLabel", "issues"],
        properties: {
          refLabel: { type: "string" },
          issues: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "reasoning"],
              properties: {
                type: { type: "string", enum: LLM_EMITTABLE_TYPES },
                reasoning: { type: "string" },
                quoteId: { type: "string" },
                suggestedSentiment: { type: "string", enum: SENTIMENT_VALUES },
                suggestedExperience: {
                  type: "string",
                  enum: EXPERIENCE_VALUES,
                },
                suggestedDepth: { type: "string", enum: DEPTH_VALUES },
                suggestedIntents: {
                  type: "array",
                  items: { type: "string", enum: INTENT_VALUES },
                },
                suggestedSpeculative: { type: "boolean" },
                suggestedQuality: { type: "string", enum: QUALITY_VALUES },
              },
            },
          },
        },
      },
    },
    commentReviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["commentLabel", "reviewComment"],
        properties: {
          commentLabel: { type: "string" },
          suggestedStatus: { type: "string", enum: COMMENT_STATUS_SUGGESTIONS },
          reviewComment: { type: "string" },
        },
      },
    },
  },
};
