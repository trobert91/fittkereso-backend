/** One weighted term of the `impact` factor, kept for tracing. */
export interface PriorityFactor {
  key: string;
  /** 0–1. */
  value: number;
  weight: number;
}

/**
 * The working behind a row's `priority` — `100 × uncertainty × impact ×
 * statusWeight` — persisted as `priorityBreakdown`.
 *
 * Without it the score is an opaque number nobody can argue with: a reviewer
 * cannot see why a row leads the queue, and a wrong ranking cannot be traced to
 * the term that caused it.
 *
 * Declared here, alongside the entity's own types, so the column can be typed
 * without `libs/database` depending on `libs/product` (where it is computed).
 */
export interface ResolutionPriorityBreakdown {
  priority: number;
  uncertainty: number;
  impact: number;
  statusWeight: number;
  /** Confidence as it stood when priority was computed, for tracing. */
  confidence: number;
  impactFactors: PriorityFactor[];
  /** False when blast radius was assumed rather than counted — a row the
   *  recompute sweep has not reached yet. */
  blastRadiusMeasured: boolean;
}
