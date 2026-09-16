import type {
  DuplicateDetectedBy,
  DuplicatePairRow,
} from '@fittkereso-backend/database';
import type { ProductCandidate } from './types';

/**
 * The pair row for a stored product and one of its candidates. Ids are
 * lowercased and ordered A < B (how Postgres orders uuids, and what the table's
 * check requires), and each gate's query and candidate values move onto A and
 * B to match.
 */
export function pairRowOf(
  queryProductId: string,
  candidate: ProductCandidate,
  detectedBy: DuplicateDetectedBy,
): DuplicatePairRow {
  const queryId = queryProductId.toLowerCase();
  const candidateId = candidate.productId.toLowerCase();
  const queryIsA = queryId < candidateId;

  return {
    productAId: queryIsA ? queryId : candidateId,
    productBId: queryIsA ? candidateId : queryId,
    similarityScore: candidate.score,
    matchedOn: candidate.matchedOn,
    matchedValue: candidate.matchedValue,
    failedGates: candidate.failedGates.map(
      ({ queryValue, candidateValue, ...gate }) => ({
        ...gate,
        productAValue: queryIsA ? queryValue : candidateValue,
        productBValue: queryIsA ? candidateValue : queryValue,
      }),
    ),
    nameSimilarity: candidate.nameSimilarity,
    detectedBy,
  };
}
