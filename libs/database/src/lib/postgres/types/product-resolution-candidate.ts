import type { MatchResultComponents } from '../../models/product-search-context';
import type { SpecMatchDetails } from './spec-match-details';

/** Per-candidate gate outcome — every gate the candidate tripped, not just the
 *  first blocking one, so a persisted row shows the complete picture. Gate
 *  names come from `QualityGatesService` (e.g. `low_confidence`,
 *  `primary_spec_mismatch`) for `product_resolution` rows, or the
 *  duplicate-detection-specific equivalents (e.g. `below_auto_merge_threshold`)
 *  for `duplicate_detection` rows. */
export interface ProductResolutionCandidateGates {
  passed: boolean;
  failedGates: string[];
}

/** One candidate considered during a resolution/duplicate-detection decision.
 *  For `product_resolution` rows this is every recall candidate; for
 *  `duplicate_detection` rows this is a single-element array representing the
 *  "other" product in the pair — normalized into the same shape so both flows
 *  are represented consistently. */
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
  specMatchDetails?: SpecMatchDetails;
}
