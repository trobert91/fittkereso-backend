import {
  ProductResolutionFlow,
  ResolutionVerdict,
} from '@fittkereso-backend/database';

/** What the producing system asserted about identity.
 *
 *  Deliberately not called a "verdict" — `ResolutionVerdict` already exists with
 *  a different meaning (the decision log's `matched_existing` / `created_new` /
 *  `duplicate_proposed` plus the human `accept` / `decline` / `reopen`). */
export type SystemAssertion = 'same' | 'different';

export interface SystemAssertionParams {
  flow: ProductResolutionFlow;
  /**
   * The seed log entry's verdict (`decisions[0].verdict`). **Authoritative when
   * present** — see the note on `resolvedProductId`.
   */
  seedVerdict?: ResolutionVerdict;
  /**
   * Only trustworthy at record time, before the scraper backfills the link.
   *
   * `ProductScrapeUpdaterService.linkResolutionToListing` sets `resolvedProduct`
   * to the persisted model **whether it was matched or newly created**, so on a
   * persisted row this field is set either way and cannot distinguish the two.
   * The seed entry can, because it is written from this same field *before* that
   * backfill runs and the log is append-only.
   */
  resolvedProductId?: string | null;
}

/**
 * Which of the two things the system claimed: that the listing *is* an existing
 * product, or that it is something new.
 */
export function deriveSystemAssertion(
  params: SystemAssertionParams,
): SystemAssertion {
  // Detection only ever proposes that two products are the same thing; it has
  // no "these are different" outcome to record.
  if (params.flow === ProductResolutionFlow.duplicate_detection) {
    return 'same';
  }

  switch (params.seedVerdict) {
    case ResolutionVerdict.matched_existing:
    case ResolutionVerdict.duplicate_proposed:
      return 'same';
    case ResolutionVerdict.created_new:
      return 'different';
    default:
      // No seed entry (a row recorded before the log existed, or the ad-hoc
      // admin endpoint), or a human verdict somehow at index 0. Fall back to the
      // catalog link, which is correct at record time and the best available
      // guess afterwards.
      return params.resolvedProductId ? 'same' : 'different';
  }
}

export interface OutcomeTensionParams extends SystemAssertionParams {
  /** 0–100. `scoring.bestCandidate.score` for a resolution, the in-process pair
   *  score for duplicate detection. */
  similarityScore: number;
  /**
   * Lowest score that could have been recorded, used to rescale.
   *
   * Rows are only written above `resolution.minScoreToRecord`, so raw scores
   * occupy the top of the range and their spread is compressed — every recorded
   * duplicate pair sits above 60, making a 62 and a 95 look far more alike than
   * they are. Passing the threshold restores the full 0–1 spread. Defaults to 0
   * (no rescaling).
   */
  floor?: number;
}

/**
 * How much the system's conclusion disagrees with how alike the two things
 * actually look. `0` = the verdict matches the surface evidence, `1` = maximally
 * at odds.
 *
 * |                     | asserted `different`        | asserted `same`         |
 * |---------------------|-----------------------------|-------------------------|
 * | **high similarity** | suspicious — missed duplicate | unremarkable          |
 * | **low similarity**  | unremarkable                | suspicious — wrong match |
 *
 * This is a different question from *margin*, which asks whether the top two
 * candidates were close together. A decision can have a wide margin and still be
 * at odds with the evidence — a confident match between two things that score 30
 * against each other is exactly the case margin cannot see.
 *
 * Pure and dependency-free so the confidence and priority services can both
 * derive it from the same rule without either importing the other.
 */
export function outcomeTension(params: OutcomeTensionParams): number {
  const assertion = deriveSystemAssertion(params);
  const similarity = rescale(params.similarityScore, params.floor ?? 0);

  // Asserting sameness is contradicted by *low* similarity; asserting difference
  // is contradicted by *high* similarity. Hence the flip.
  return assertion === 'same' ? 1 - similarity : similarity;
}

/** Maps a 0–100 score onto 0–1, stretching `[floor, 100]` across the full range
 *  so a threshold-truncated distribution keeps its spread. */
function rescale(score: number, floor: number): number {
  const bounded = clamp(score, 0, 100);
  const boundedFloor = clamp(floor, 0, 99);
  return clamp((bounded - boundedFloor) / (100 - boundedFloor), 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
