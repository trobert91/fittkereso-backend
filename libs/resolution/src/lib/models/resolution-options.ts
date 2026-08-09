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
}
