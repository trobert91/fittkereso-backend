import type {
  ProductResolutionCandidateRecord,
  ProductResolutionDecisionSnapshot,
} from '@fittkereso-backend/database';
import { isEmpty, maxBy, orderBy, isNumber } from 'lodash';

/**
 * The candidate a row's outcome is *about*.
 *
 * On a match it is the one that was picked. On a rejection it is the strongest
 * one — a rejection is a claim about the candidate that came closest, not about
 * the pool in general, so scoring it against anything else would answer a
 * question nobody asked.
 *
 * Shared by `ResolutionConfidenceService` (which scores the subject's specs,
 * gates and components) and `ResolutionReviewTriggerService` (which tests the
 * same subject for suspicion patterns). They must agree on which candidate they
 * are talking about, or a trigger would describe one product while the
 * confidence it is meant to guard describes another.
 */
export function subjectCandidate(
  candidates?: ProductResolutionCandidateRecord[],
  decisionSnapshot?: ProductResolutionDecisionSnapshot,
): ProductResolutionCandidateRecord | undefined {
  if (isEmpty(candidates)) return undefined;

  const pickedId = decisionSnapshot?.selectedCandidates?.[0]?.candidateId;
  const picked = pickedId
    ? candidates?.find((entry) => entry.candidateId === pickedId)
    : undefined;

  return picked ?? maxBy(candidates, (entry) => entry.matchScore ?? 0);
}

/**
 * The top two matcher scores, descending.
 *
 * Read off the persisted candidates rather than the resolution pipeline's
 * in-memory `scoring`, which is not stored — so the record-time and sweep paths
 * see the same two numbers and cannot disagree about the margin.
 *
 * `compact` would be wrong here: a candidate that scored 0 is a real runner-up,
 * and dropping it would read as "no second candidate", silently removing the
 * margin from both the confidence formula and the `narrow_margin` trigger.
 */
export function topTwoScores(
  candidates?: ProductResolutionCandidateRecord[],
): { bestScore?: number; secondScore?: number } | undefined {
  if (isEmpty(candidates)) return undefined;

  const scores = orderBy(
    (candidates ?? [])
      .map((candidate) => candidate.matchScore)
      .filter(isNumber),
    [(score) => score],
    ['desc'],
  );

  return { bestScore: scores[0], secondScore: scores[1] };
}
