import type {
  DuplicateDetectedBy,
  DuplicatePairRow,
} from '@fittkereso-backend/database';
import type { KeyMatch } from './product-key-lookup.service';
import type { FailedGate, ProductCandidate } from './types';

/**
 * The pair row for a listing's product and another product one of the
 * listing's identifiers points at. Scored 100: sharing a GTIN, an MPN or a
 * declared size group is the strongest duplicate evidence there is, and the
 * failed gates beside it show the reviewer what still contradicts. There is
 * no name comparison behind it, hence no name similarity.
 *
 * `failedGates` compare the listing (standing in for its product) with the
 * other product, so the listing's values go on its product's side.
 */
export function keyPairRowOf(
  productId: string,
  match: KeyMatch,
  failedGates: FailedGate[],
  detectedBy: DuplicateDetectedBy,
): DuplicatePairRow {
  const ownId = productId.toLowerCase();
  const otherId = match.productId.toLowerCase();
  const ownIsA = ownId < otherId;

  return {
    productAId: ownIsA ? ownId : otherId,
    productBId: ownIsA ? otherId : ownId,
    similarityScore: 100,
    matchedOn: match.via,
    matchedValue: match.key,
    failedGates: failedGates.map(({ queryValue, candidateValue, ...gate }) => ({
      ...gate,
      productAValue: ownIsA ? queryValue : candidateValue,
      productBValue: ownIsA ? candidateValue : queryValue,
    })),
    nameSimilarity: null,
    matcherModelMatch: null,
    detectedBy,
  };
}

/**
 * How strongly a candidate is a duplicate: its name score, or — when the two
 * products share a matcherModel key — its spec gates alone, whichever is
 * higher. Two shops wording one model differently ("Tour CX 830", "Macina Tour
 * CX830") can score low on the name and still be the same bike.
 */
export function pairScoreOf(candidate: ProductCandidate): number {
  return candidate.matcherModelMatch
    ? Math.max(candidate.score, candidate.keyScore)
    : candidate.score;
}

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
    similarityScore: pairScoreOf(candidate),
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
    matcherModelMatch: candidate.matcherModelMatch ?? null,
    detectedBy,
  };
}
