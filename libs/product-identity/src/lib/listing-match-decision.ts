import { isEmpty, orderBy } from 'lodash';
import { ACCEPT_SCORE, NEAR_MISS_SCORE } from './product-identity.constants';

export type ListingMatchChoice<T> =
  | { kind: 'attach'; candidate: T }
  | { kind: 'ask_llm'; candidates: T[] }
  | { kind: 'not_found' };

/**
 * The listing match rule. Exactly one candidate at ACCEPT_SCORE or above is
 * attached. Otherwise every candidate at NEAR_MISS_SCORE or above goes to the
 * LLM, best first — including two or more at ACCEPT_SCORE, which the score
 * can't choose between. With none, the listing is a new product and the LLM
 * isn't asked.
 */
export function decideListingMatch<T extends { score: number }>(
  candidates: T[],
): ListingMatchChoice<T> {
  const accepted = candidates.filter(
    (candidate) => candidate.score >= ACCEPT_SCORE,
  );
  if (accepted.length === 1) {
    return { kind: 'attach', candidate: accepted[0] };
  }

  const nearMisses = candidates.filter(
    (candidate) => candidate.score >= NEAR_MISS_SCORE,
  );
  if (isEmpty(nearMisses)) {
    return { kind: 'not_found' };
  }

  return {
    kind: 'ask_llm',
    candidates: orderBy(nearMisses, (candidate) => candidate.score, 'desc'),
  };
}
