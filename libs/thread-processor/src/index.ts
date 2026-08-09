export * from './lib/thread-processor.module';
export * from './lib/thread-processor-shared.module';
export * from './lib/interfaces';
export * from './lib/services/thread-extraction.service';
export * from './lib/services/media-analyzer.service';
export * from './lib/services/image-analyzer.service';
export * from './lib/services/product-reference-resolution.service';
// Re-exported for consumers that need pipeline domain models outside the pipeline
// (e.g. admin tooling inspecting a reconstructed thread context, or the
// benchmark app driving prompts in isolation).
export { ThreadContext } from './lib/models/thread-context';
export type { ThreadCategoryConfig } from './lib/models/thread-context';
export { SubtreeBuilderService } from './lib/services/subtree-builder.service';
export {
  referenceToResolutionInput,
  pooledGroupInput,
  isCategoryResolvable,
} from './lib/services/reference-to-resolution-input';
export { CommentModerationDecisionService } from './lib/services/moderation/comment-moderation-decision.service';
export type { CommentModerationDecision } from './lib/services/moderation/comment-moderation-decision.service';
export { PromptAssemblyService } from './lib/services/prompt-assembly.service';
export type { AssembledPrompt } from './lib/services/prompt-assembly.service';
export {
  IDENTIFICATION_JSON_SCHEMA,
  IdentificationResponseSchema,
} from './lib/schemas/subtree-identification.schema';
export type {
  IdentificationLLMResponse,
  LLMMappedProduct,
} from './lib/schemas/subtree-identification.schema';
export {
  EXTRACTION_JSON_SCHEMA,
  ExtractionResponseSchema,
} from './lib/schemas/subtree-extraction.schema';
export type {
  ExtractionLLMResponse,
  LLMExtractedComment,
  LLMExtractedProduct,
  LLMExtractedSpec,
  LLMQuote,
} from './lib/schemas/subtree-extraction.schema';
export {
  buildLabelingJsonSchema,
  LabelingResponseSchema,
} from './lib/schemas/quote-labeling.schema';
export type {
  LabelingLLMResponse,
  LLMLabeledProduct,
  LLMLabeledQuote,
  LLMEvidence,
  LLMReferenceDetails,
} from './lib/schemas/quote-labeling.schema';
export { buildLabelingSystemPrompt } from './lib/prompts/quote-labeler.prompt';
export type { LabelingPromptOptions } from './lib/prompts/quote-labeler.prompt';
export {
  buildCommentLabelMap,
  collectExtractedRefs,
} from './lib/prompts/quote-labeler.user-prompt';
export type {
  Subtree,
  SubtreeMap,
  SubtreeNode,
  SubtreeBuilderOptions,
  NodeType,
} from './lib/models/subtree.model';
export {
  buildValidationSystemPrompt,
  buildValidationUserPrompt,
} from './lib/prompts/llm-validation.prompt';
export type { ValidationPromptOptions } from './lib/prompts/llm-validation.prompt';
export {
  LLM_VALIDATION_JSON_SCHEMA,
  LlmValidationResponseSchema,
} from './lib/schemas/llm-validation.schema';
export type {
  LlmValidationResponse,
  LlmEmittedRef,
  LlmEmittedIssue,
} from './lib/schemas/llm-validation.schema';
export { ValidationSubtreeRenderer } from './lib/services/validation/validation-subtree-renderer';
export type { RenderedValidationSubtree } from './lib/services/validation/validation-subtree-renderer';
