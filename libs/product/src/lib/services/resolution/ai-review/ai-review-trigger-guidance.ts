import { ResolutionReviewTrigger } from '@fittkereso-backend/database';

/**
 * What to actually look at, per trigger.
 *
 * This is the triggers' second job. Blocking auto-accept is the first; routing
 * the prompt is what makes an AI review worth its tokens, because a generic
 * "check this row" gets a generic answer while naming the suspicion gets the
 * specific comparison made.
 *
 * Written as instructions to a reviewer rather than as definitions — the model
 * already has the row, what it needs is where to point.
 */
export const TRIGGER_GUIDANCE: Record<ResolutionReviewTrigger, string> = {
  [ResolutionReviewTrigger.spec_conflict]:
    'The pipeline called these the same product while at least one spec disagrees. Read the conflicting spec on both sides. Decide whether it is a real difference in the product, or the same value written two ways by two shops (different units, a trade name vs a generic one, a rounded figure). A real primary-spec difference means these are different products.',

  [ResolutionReviewTrigger.narrow_margin]:
    'Two candidates scored within a few points of each other, so the winner was close to arbitrary. Ignore the scores and compare the top candidates on their specs and aliases instead. If a different candidate is the better match, say so; if they are indistinguishable on the evidence, abstain rather than ratifying a coin-flip.',

  [ResolutionReviewTrigger.name_only_match]:
    'The match rests entirely on the names looking alike — no comparable specs, no shared alias. This is how two unrelated products with similar names get merged. Look for anything that independently confirms or refutes sameness. If nothing does, that absence is your answer.',

  [ResolutionReviewTrigger.gate_only_rejection]:
    'A candidate scored well enough to accept and a quality gate stopped it. The gate fired on the same numbers the score came from, so the pipeline cannot tell you whether it was right — that is the question. Read the failed gate, then check whether the objection is real against the live specs. Gates are conservative by design and this is where they most often overreach.',

  [ResolutionReviewTrigger.near_miss_rejection]:
    'The best candidate fell just short of the accept threshold, so a new product was created instead. If they are the same product, the catalog now holds a duplicate. Compare the listing against that candidate directly and ignore how close the score was to the bar.',

  [ResolutionReviewTrigger.no_candidates_but_named]:
    'Recall found nothing, yet the catalog does hold this brand in this category — so the products listed below came from a direct catalog lookup rather than from recall. One of them may well be the answer that recall missed, usually because of a brand-alias gap or an over-tight filter. Check them against the listing.',

  [ResolutionReviewTrigger.insufficient_evidence]:
    'Nothing was recalled and the listing named neither a brand nor a model. There is very likely nothing here to judge — abstain unless something in the candidates below genuinely settles it.',
};
