import type { MatchResultComponents } from '../../models/product-search-context';
import type { SpecMatchDetails } from './spec-match-details';

/** Per-candidate gate outcome — every gate the candidate tripped, not just the
 *  first blocking one, so a persisted row shows the complete picture. Gate
 *  names come from `QualityGatesService` (e.g. `low_confidence`,
 *  `primary_spec_mismatch`) for `product_resolution` rows, or the
 *  duplicate-detection-specific equivalents (e.g. `below_auto_merge_threshold`)
 *  for `duplicate_detection` rows.
 *
 *  Two names are synthesized rather than produced by a gate, because the
 *  alternative — an empty `failedGates` with `passed: false` — reads as "every
 *  gate was evaluated and none of them objected", which is the opposite of what
 *  happened:
 *   - `filter_<reason>`: dropped by the filter stage before scoring.
 *   - `not_scored`: reached neither the matcher nor the gates (the pool was
 *     empty, scoring produced no match for it, or the run ended earlier). "We
 *     never formed an opinion", not "we rejected it". */
export interface ProductResolutionCandidateGates {
  passed: boolean;
  failedGates: string[];
}

/** One candidate considered during a resolution/duplicate-detection decision.
 *  For `product_resolution` rows this is every recall candidate; for
 *  `duplicate_detection` rows this is a single-element array representing the
 *  "other" product in the pair — normalized into the same shape so both flows
 *  are represented consistently.
 *
 *  Deliberately holds no copy of the candidate's own specs, aliases or
 *  category. Everything here is either an identifying label or something the
 *  matcher *derived* — a score, a component breakdown, a gate outcome, a spec
 *  verdict — which depends on the config and code of the moment and cannot be
 *  recomputed later. The candidate's entity data can: `candidateId` is a live
 *  product id, so a reviewer loads it fresh. That is also the only correct
 *  version to review against, since acting on the row acts on the product as it
 *  is now, not as it was when the row was written. */
export interface ProductResolutionCandidateRecord {
  candidateId: string;
  brand?: string;
  model?: string;
  displayName?: string;
  source:
    | 'fuzzy'
    | 'embedding'
    | 'web'
    | 'duplicate_detection_pair'
    | 'reference_short_circuit';
  matchScore?: number;
  matchComponents?: MatchResultComponents;
  gates: ProductResolutionCandidateGates;
  /** Set when the candidate was dropped by the filter stage (brand/category/
   *  primary-spec contradiction) before scoring ever ran, so a persisted row
   *  shows near-misses rather than only the survivors. `detail` is the
   *  human-readable contradiction, e.g. `usageType MTB ≠ Összteleszkópos MTB`.
   *  Absent for candidates that reached scoring. */
  filtered?: {
    reason: 'match_specs' | 'category' | 'brand';
    detail: string;
  };
  specMatchDetails?: SpecMatchDetails;
}
