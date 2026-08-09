/**
 * Shared miss-rate retry helper for batched per-comment LLM steps (product
 * discovery, comment identification). A step is expected to return a result for
 * every [PLAN] comment; when the model silently drops too many, the batch is
 * worth one retry before we accept the lossy output.
 *
 * This module owns only the policy (compute the miss rate, decide to retry). The
 * caller owns the LLM call and how covered IDs are extracted from a response, so
 * the same policy serves responses with different shapes.
 */

/** Fraction of expected PLAN comments missing from `coveredIds` (0..1). */
export function computeMissRate(
  expectedIds: readonly string[],
  coveredIds: ReadonlySet<string>,
): number {
  if (expectedIds.length === 0) return 0;
  const missing = expectedIds.filter((id) => !coveredIds.has(id)).length;
  return missing / expectedIds.length;
}

export interface MissRateRetryOptions<T> {
  /** Expected PLAN comment short IDs (e.g. ['c0','c1',...]). */
  expectedIds: readonly string[];
  /** Run the LLM step once. */
  attempt: () => Promise<T>;
  /** Extract the set of comment IDs the response actually covered. */
  coveredIds: (result: T) => ReadonlySet<string>;
  /** Retry once when the miss rate is strictly above this threshold (0..1). */
  threshold: number;
  /** Optional hook invoked when a retry is triggered (for logging). */
  onRetry?: (missRate: number) => void;
}

/**
 * Run `attempt`; if the miss rate exceeds `threshold`, run it a second time and
 * keep whichever result covered more comments. At most two attempts.
 */
export async function withMissRateRetry<T>(
  options: MissRateRetryOptions<T>,
): Promise<T> {
  const { expectedIds, attempt, coveredIds, threshold, onRetry } = options;

  const first = await attempt();
  const firstMissRate = computeMissRate(expectedIds, coveredIds(first));
  if (firstMissRate <= threshold) return first;

  onRetry?.(firstMissRate);
  const second = await attempt();
  const secondMissRate = computeMissRate(expectedIds, coveredIds(second));

  // Keep the better-covering attempt (lower miss rate wins; ties keep the retry,
  // which is at least as fresh).
  return secondMissRate <= firstMissRate ? second : first;
}
