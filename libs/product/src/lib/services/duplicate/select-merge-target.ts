export interface MergeTargetCandidate {
  id: string;
  createdAt?: Date;
}

/**
 * Decides which of two duplicate products survives a merge: the **oldest one
 * wins** and becomes the target, so the surviving row is the one other data has
 * had the longest to accumulate around.
 *
 * Pure and dependency-free so both the duplicate-detection flow and the review
 * queue's accept action pick the same direction without one importing the
 * other's service.
 */
export function selectMergeTarget(
  pairItemA: MergeTargetCandidate,
  pairItemB: MergeTargetCandidate,
): { sourceId: string; targetId: string } {
  const createdAtA = pairItemA.createdAt ?? new Date();
  const createdAtB = pairItemB.createdAt ?? new Date();
  return createdAtA <= createdAtB
    ? { sourceId: pairItemB.id, targetId: pairItemA.id }
    : { sourceId: pairItemA.id, targetId: pairItemB.id };
}
