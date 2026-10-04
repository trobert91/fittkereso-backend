import { isEmpty, orderBy } from 'lodash';
import {
  ACCEPT_SCORE,
  LLM_MAX_MATCHER_SPEC_MISMATCHES,
  NEAR_MISS_SCORE,
} from './product-identity.constants';
import type { FailedGate } from './types';

export type ListingMatchChoice<T> =
  | { kind: 'attach'; candidate: T }
  | { kind: 'ask_llm'; candidates: T[] }
  | { kind: 'not_found' };

/** What the rule reads of a candidate. */
export interface KeyedCandidate {
  score: number;
  keyScore?: number;
  normalizedModelMatch?: boolean;
  failedGates?: Pick<FailedGate, 'gate'>[];
  createdAt?: Date;
}

/**
 * The listing match rule. Only a candidate with the listing's normalizedModel
 * can attach, and only on its spec gates (`keyScore` at ACCEPT_SCORE): an
 * equal key says the names agree, and the gates say whether year, primary and
 * matcher specs make it another product — two products often share a key. The
 * best eligible one attaches, by keyScore, then the oldest product, so two
 * products already sharing a key never block each other.
 *
 * Otherwise the LLM gets the candidates a shop's wording could still make the
 * same product: a name at NEAR_MISS_SCORE with no primary-spec contradiction
 * and at most LLM_MAX_MATCHER_SPEC_MISMATCHES matcher ones, whatever their
 * key. With none, the listing is a new product.
 */
export function decideListingMatch<T extends KeyedCandidate>(
  candidates: T[],
): ListingMatchChoice<T> {
  const eligible = orderBy(
    candidates.filter(
      (candidate) =>
        candidate.normalizedModelMatch === true && (candidate.keyScore ?? 0) >= ACCEPT_SCORE,
    ),
    [
      (candidate) => candidate.keyScore ?? 0,
      (candidate) => candidate.createdAt?.getTime() ?? 0,
    ],
    ['desc', 'asc'],
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
