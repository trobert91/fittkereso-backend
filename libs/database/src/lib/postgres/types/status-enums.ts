export enum ThreadStatus {
  NEW = 'new',
  REPROCESSING = 'reprocessing',
  PROCESSING = 'processing',
  SELECTED = 'selected',
  LOW_ESTIMATION = 'low_estimation',
  LLM_NO_CATEGORY = 'llm_no_category',
  LLM_LOW_RELEVANCE = 'llm_low_relevance',
  PROCESSED = 'extracted',
  DELETED = 'deleted',
}

export enum CommentStatus {
  NEW = 'new',
  IDENTIFIED = 'identified',
  EXTRACTED = 'extracted',
  LABELED = 'labeled',
  VALIDATED = 'validated',
  RELEVANCE_CALCULATED = 'relevance_calculated',
  IN_REVIEW = 'in_review',
  APPROVED = 'approved',
  DELETED = 'deleted',
  SKIPPED = 'skipped',
}

/**
 * The three terminal statuses a moderation decision can assign to a comment.
 * A strict subset of `CommentStatus` (same runtime values), used by the
 * moderation rule and persisted as `UserComment.validationDecision`.
 */
export type ModerationStatus =
  | CommentStatus.APPROVED
  | CommentStatus.IN_REVIEW
  | CommentStatus.DELETED;
