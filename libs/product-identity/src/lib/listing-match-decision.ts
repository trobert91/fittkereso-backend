import { isEmpty, orderBy } from 'lodash';
import type { ListingMatchMode } from '@fittkereso-backend/database';
import {
  ACCEPT_SCORE,
  CLEAR_WINNER_LEAD,
  CLEAR_WINNER_SCORE,
  LLM_MAX_MATCHER_SPEC_MISMATCHES,
  NEAR_MISS_SCORE,
} from './product-identity.constants';
import type { FailedGate } from './types';

export type ListingMatchChoice<T> =
  | { kind: 'attach'; candidate: T }
  | { kind: 'ask_llm'; candidates: T[] }
  | { kind: 'not_found' };

/** What the key rule reads of a candidate, beside the score both rules rank on. */
export interface KeyedCandidate {
  score: number;
  keyScore?: number;
  matcherModelMatch?: boolean;
  failedGates?: Pick<FailedGate, 'gate'>[];
  createdAt?: Date;
}

export interface ListingDecisionOptions {
  /** `score` by default. */
  mode?: ListingMatchMode;
  /**
   * The listing's key has a single word: equal keys say too little on their
   * own, so the key rule also wants the name score at ACCEPT_SCORE.
   */
  shortKey?: boolean;
}

/**
 * The listing match rule.
 *
 * `score` mode: exactly one candidate at ACCEPT_SCORE or above is attached.
 * With two or more there, the best is still attached when it is a clear winner
 * (see `clearWinnerOf`). Otherwise every candidate at NEAR_MISS_SCORE or above
 * goes to the LLM, best first. With none, the listing is a new product and the
 * LLM isn't asked.
 *
 * `key` mode (see decideByKey): only a candidate sharing the listing's
 * matcherModel key attaches, on its spec gates alone.
 */
export function decideListingMatch<T extends KeyedCandidate>(
  candidates: T[],
  options: ListingDecisionOptions = {},
): ListingMatchChoice<T> {
  if (options.mode === 'key') return decideByKey(candidates, options);

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
 * The key rule. A candidate is eligible when one of its listings has the
 * listing's matcherModel key and its spec gates alone leave ACCEPT_SCORE
 * (`keyScore`); the name score is not required, since two shops can word one
 * key's model differently, except behind a one-word key. The best eligible
 * one attaches — by keyScore, then name score, then the oldest product — so
 * two products already sharing a key never block each other.
 *
 * Otherwise the LLM gets the candidates a shop's wording could still make the
 * same bike: a name at NEAR_MISS_SCORE with no primary-spec contradiction and
 * at most LLM_MAX_MATCHER_SPEC_MISMATCHES matcher ones, whatever their key.
 * With none, the listing is a new product.
 */
function decideByKey<T extends KeyedCandidate>(
  candidates: T[],
  { shortKey = false }: ListingDecisionOptions,
): ListingMatchChoice<T> {
  const eligible = orderBy(
    candidates.filter(
      (candidate) =>
        candidate.matcherModelMatch === true &&
        (candidate.keyScore ?? 0) >= ACCEPT_SCORE &&
        (!shortKey || candidate.score >= ACCEPT_SCORE),
    ),
    [
      (candidate) => candidate.keyScore ?? 0,
      (candidate) => candidate.score,
      (candidate) => candidate.createdAt?.getTime() ?? 0,
    ],
    ['desc', 'desc', 'asc'],
  );
  if (!isEmpty(eligible)) {
    return { kind: 'attach', candidate: eligible[0] };
  }

  const forLlm = orderBy(
    candidates.filter((candidate) => {
      const gates = candidate.failedGates ?? [];
      return (
        candidate.score >= NEAR_MISS_SCORE &&
        !gates.some((gate) => gate.gate === 'primarySpecMismatch') &&
        gates.filter((gate) => gate.gate === 'matcherSpecMismatch').length <=
          LLM_MAX_MATCHER_SPEC_MISMATCHES
      );
    }),
    (candidate) => candidate.score,
    'desc',
  );
  return isEmpty(forLlm) ? { kind: 'not_found' } : { kind: 'ask_llm', candidates: forLlm };
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
