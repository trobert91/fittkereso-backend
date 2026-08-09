/**
 * Thread-scoped context the decision LLM needs.
 *
 * Mirrors `ResolutionThreadContext` from `@ebike-backend/database` but lives
 * in this lib's namespace so callers don't have to reach across libraries.
 * The new lib never touches the thread-scoped `productRegistry` — that stays
 * caller-side under `withRegistryKeyLock`.
 */
export interface ResolutionThreadContext {
  threadTitle: string;
  subreddit: string;
  opSummary?: string;
  /** displayNames of products already resolved in the thread (cheat-sheet hint). */
  resolvedProducts?: string[];
  /** The comment body being resolved — surfaced to the decision LLM. */
  commentBody?: string;
  /** Direct parent's body, when the parent isn't the OP. Omitted when the
   *  current comment is the OP, the parent is the OP (use `opSummary` instead),
   *  or the parent is missing. Populated by `buildAncestorBodies` (callers in
   *  `libs/thread-processor`). */
  parentCommentBody?: string;
  /** Grandparent's body, when neither parent nor grandparent is the OP.
   *  Omitted when parent is the OP, grandparent is the OP, or grandparent is
   *  missing. */
  grandparentCommentBody?: string;
}

/**
 * Everything the caller passes that isn't part of the per-reference `input`.
 * Currently just the thread/comment context; no registry map flows across the
 * lib boundary.
 */
export interface CallerContext {
  threadContext?: ResolutionThreadContext;
  /** Thread the resolution is running for. Plumbed onto every LLM call so
   *  per-thread cost accounting in `DebugTraceService` captures resolution
   *  spend alongside extraction/validation. Omitted for callers that have no
   *  thread (admin tools, product-scraper rescrape, deferred retry). */
  threadId?: string;
}
