import { isEmpty, orderBy } from 'lodash';
import {
  ACCEPT_SCORE,
  CLEAR_WINNER_LEAD,
  CLEAR_WINNER_SCORE,
  NEAR_MISS_SCORE,
} from './product-identity.constants';

export type ListingMatchChoice<T> =
  | { kind: 'attach'; candidate: T }
  | { kind: 'ask_llm'; candidates: T[] }
  | { kind: 'not_found' };

/**
 * The listing match rule. Exactly one candidate at ACCEPT_SCORE or above is
 * attached. With two or more there, the best is still attached when it is a
 * clear winner (see `clearWinnerOf`). Otherwise every candidate at
 * NEAR_MISS_SCORE or above goes to the LLM, best first. With none, the listing
 * is a new product and the LLM isn't asked.
 */
export function decideListingMatch<T extends { score: number }>(
  candidates: T[],
): ListingMatchChoice<T> {
  const ranked = orderBy(candidates, (candidate) => candidate.score, 'desc');
  const accepted = ranked.filter((candidate) => candidate.score >= ACCEPT_SCORE);
  if (accepted.length === 1) {
    return { kind: 'attach', candidate: accepted[0] };
  }

  const winner = clearWinnerOf(accepted);
  if (winner) {
    return { kind: 'attach', candidate: winner };
  }

  const nearMisses = ranked.filter((candidate) => candidate.score >= NEAR_MISS_SCORE);
  if (isEmpty(nearMisses)) {
    return { kind: 'not_found' };
  }

  return { kind: 'ask_llm', candidates: nearMisses };
}

/**
 * The best of several accepted candidates, when the score can tell them apart:
 * it reaches CLEAR_WINNER_SCORE and leads the runner-up by CLEAR_WINNER_LEAD.
 * Two candidates both at the top (two products already duplicating each
 * other) are a tie, and stay one.
 */
function clearWinnerOf<T extends { score: number }>(rankedAccepted: T[]): T | undefined {
  const [best, runnerUp] = rankedAccepted;
  if (!best || !runnerUp) return undefined;

  const isClear =
    best.score >= CLEAR_WINNER_SCORE && best.score - runnerUp.score >= CLEAR_WINNER_LEAD;
  return isClear ? best : undefined;
}
