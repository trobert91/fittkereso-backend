/**
 * Behavior knobs the caller passes alongside the input.
 *
 * Only true behavior controls live here. Identification data (brand, category,
 * specs, reference clues) lives on `ProductResolutionInput`.
 */
export interface ResolutionOptions {
  /** Run the embedding-recall strategy when fuzzy returns no hits. */
  useEmbedding: boolean;
  /** Allow `WebRecall` to fire SERP queries. Gated upstream by the caller's
   *  contentQuality / OP / reference-clue heuristics. */
  webSearchEnabled: boolean;
  /** Strict vs loose matcher gates. */
  mode: 'strict' | 'loose';
  /** Let `DecisionService` fall back to an LLM decision when the matcher's
   *  quality gates reject every candidate, independent of web search having
   *  run. Decoupled from `webSearchEnabled` on purpose: scrape-time callers
   *  want the LLM merge-adjudication fallback without turning on SERP web
   *  search (different cost/latency profile, different evidence type).
   *  Default false — only scrape-time resolution opts in. */
  llmDecisionEnabled?: boolean;
  /** Which `DecisionStrategy` `DecisionService` should invoke when it decides
   *  to call an LLM at all (either via `webSearchEnabled && webSearchRan`, or
   *  via `llmDecisionEnabled`). 'comment' (default) asks "which of these
   *  candidates does this mention refer to" (`LlmDecisionStrategy`) — the
   *  original comment/mention-resolution framing. 'scrape-merge' asks the
   *  narrower, binary "is this scraped listing the same product as this
   *  candidate" (`ScrapeMergeDecisionStrategy`) — used by scrape-time
   *  resolution, where there is no web evidence and multi-pick doesn't apply. */
  decisionStrategy?: 'comment' | 'scrape-merge';
}
