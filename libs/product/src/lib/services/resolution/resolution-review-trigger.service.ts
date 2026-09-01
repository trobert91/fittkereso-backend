import { Injectable } from '@nestjs/common';
import {
  ProductResolutionFlow,
  ResolutionReviewTrigger,
  type ProductDuplicateDetectionInputSnapshot,
  type ProductResolutionCandidateRecord,
  type ProductResolutionDecisionSnapshot,
  type ProductResolutionInputSnapshot,
  type ResolutionVerdict,
  type SpecMatchDetails,
} from '@fittkereso-backend/database';
import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { compact, isEmpty } from 'lodash';
import { deriveSystemAssertion, type SystemAssertion } from './outcome-tension';
import {
  subjectCandidate,
  topTwoScores,
} from './resolution-subject-candidate';

/** Everything a trigger can be decided from. Same shape whether the caller holds
 *  params about to be written or a row already in the table, so the record-time
 *  and sweep paths classify identically. */
export interface ReviewTriggerInput {
  flow: ProductResolutionFlow;
  /** `decisions[0].verdict` — authoritative for the assertion. */
  seedVerdict?: ResolutionVerdict;
  resolvedProductId?: string | null;
  candidates?: ProductResolutionCandidateRecord[];
  specMatchDetails?: SpecMatchDetails;
  decisionSnapshot?: ProductResolutionDecisionSnapshot;
  inputSnapshot?:
    | ProductResolutionInputSnapshot
    | ProductDuplicateDetectionInputSnapshot;
  /**
   * Does the catalog hold any product of this row's brand **and** category?
   *
   * Injected rather than queried, so this service stays pure and the scrape hot
   * path stays query-free. `undefined` means *not looked up* — which suppresses
   * `no_candidates_but_named` rather than guessing at it. That is the intended
   * behaviour at record time: the nightly sweep supplies the answer from one
   * grouped count and the trigger appears then.
   */
  catalogHasBrandCategorySiblings?: boolean;
}

interface TriggerThresholds {
  acceptThreshold: number;
  ambiguityGap: number;
  nearMissBand: number;
  nameOnlySpecSimilarityMax: number;
}

/**
 * Classifies a resolution row: *why might this be wrong?*
 *
 * Pure — no I/O, every threshold injected — so it is cheap enough to run on the
 * scrape hot path inside `ResolutionScoringService`, which is what lets
 * `reviewTriggers` ride along in the same `ResolutionScores` struct as the two
 * scores and reach every existing write path without a new call site.
 *
 * Three values, three meanings. `NULL` on a row means this never ran, and an
 * unclassified row is ineligible for every automated path. `[]` means it ran and
 * nothing fired — the value deterministic auto-accept trusts absolutely. A
 * non-empty list names the patterns that matched.
 *
 * The list is deliberately short. Every entry has to earn its place by blocking
 * auto-accept, routing the AI prompt, or being a filter chip worth clicking; a
 * trigger that fires on rows which turn out to be *correct* decisions is worse
 * than no trigger at all, because it erodes what `[]` means.
 */
@Injectable()
export class ResolutionReviewTriggerService {
  constructor(private readonly dynamicConfigService: DynamicConfigService) {}

  public triggersFor(input: ReviewTriggerInput): ResolutionReviewTrigger[] {
    const thresholds = this.thresholds();
    const assertion = deriveSystemAssertion(input);
    const subject = subjectCandidate(input.candidates, input.decisionSnapshot);
    const scores = topTwoScores(input.candidates);
    const specs = input.specMatchDetails ?? subject?.specMatchDetails;

    return compact([
      this.specConflict(assertion, specs),
      this.narrowMargin(assertion, scores, thresholds),
      this.nameOnlyMatch(assertion, subject, thresholds),
      this.gateOnlyRejection(assertion, subject, thresholds),
      this.nearMissRejection(assertion, subject, thresholds),
      ...this.zeroCandidateTriggers(input),
    ]);
  }

  /** Asserted sameness while the specs say otherwise. The only trigger reading a
   *  direct contradiction rather than a weak or missing signal, which is why it
   *  fires on `matcherSpecMismatches` too and not just primary ones. */
  private specConflict(
    assertion: SystemAssertion,
    specs?: SpecMatchDetails,
  ): ResolutionReviewTrigger | undefined {
    if (assertion !== 'same' || !specs) return undefined;

    return specs.primaryMismatches > 0 || specs.matcherSpecMismatches > 0
      ? ResolutionReviewTrigger.spec_conflict
      : undefined;
  }

  /**
   * The winner barely beat the runner-up.
   *
   * This is the trigger that most earns its keep as an auto-accept blocker.
   * `margin` carries only .085 of the confidence weight, so the difference
   * between a 2-point gap and a 40-point one is worth about three points of
   * confidence — nowhere near enough to stop a coin-flip from clearing 90 on the
   * strength of the other components.
   */
  private narrowMargin(
    assertion: SystemAssertion,
    scores: { bestScore?: number; secondScore?: number } | undefined,
    thresholds: TriggerThresholds,
  ): ResolutionReviewTrigger | undefined {
    if (assertion !== 'same') return undefined;

    const { bestScore, secondScore } = scores ?? {};
    if (bestScore === undefined || secondScore === undefined) return undefined;

    return bestScore - secondScore < thresholds.ambiguityGap
      ? ResolutionReviewTrigger.narrow_margin
      : undefined;
  }

  /**
   * Nothing independent of the name backs the match.
   *
   * `specSimilarity` and `aliasMatch` are excluded from the match score itself
   * (see `ProductSimilarityService` — the score is built from name components
   * and spec penalties), so they are the only genuinely separate evidence a row
   * carries. Neither present means two products whose names merely look alike.
   *
   * Not an auto-accept blocker: a row in this shape loses `specAgreement`
   * entirely and scores zero on `corroboration`, which already puts it far below
   * 90 on its own. It stays as an AI router and a human filter.
   */
  private nameOnlyMatch(
    assertion: SystemAssertion,
    subject: ProductResolutionCandidateRecord | undefined,
    thresholds: TriggerThresholds,
  ): ResolutionReviewTrigger | undefined {
    const components = subject?.matchComponents;
    if (assertion !== 'same' || !components) return undefined;

    const corroborated =
      components.specSimilarity > thresholds.nameOnlySpecSimilarityMax ||
      components.aliasMatch;

    return corroborated ? undefined : ResolutionReviewTrigger.name_only_match;
  }

  /**
   * A candidate scored well enough to accept and a gate stopped it.
   *
   * The richest class for an AI reviewer, because it is where confidence is
   * structurally weakest: `gateAgreement` reports that the gate fired, but the
   * gate fired on the same score and spec counts that `outcomeAgreement` and
   * `specAgreement` already read. The number therefore agrees with itself rather
   * than corroborating anything, and the question of whether the gate was *right*
   * is exactly what no stored signal answers.
   */
  private gateOnlyRejection(
    assertion: SystemAssertion,
    subject: ProductResolutionCandidateRecord | undefined,
    thresholds: TriggerThresholds,
  ): ResolutionReviewTrigger | undefined {
    if (assertion !== 'different' || !subject?.gates) return undefined;
    if (subject.gates.passed) return undefined;
    if (subject.matchScore === undefined) return undefined;

    return subject.matchScore >= thresholds.acceptThreshold
      ? ResolutionReviewTrigger.gate_only_rejection
      : undefined;
  }

  /** The best candidate fell just short of the accept threshold. Distinct from
   *  `narrow_margin`, which compares the top two candidates to each other: this
   *  compares the top one to the bar. A row can trip either without the other. */
  private nearMissRejection(
    assertion: SystemAssertion,
    subject: ProductResolutionCandidateRecord | undefined,
    thresholds: TriggerThresholds,
  ): ResolutionReviewTrigger | undefined {
    if (assertion !== 'different' || subject?.matchScore === undefined) {
      return undefined;
    }

    const { acceptThreshold, nearMissBand } = thresholds;
    const withinBand =
      subject.matchScore < acceptThreshold &&
      subject.matchScore >= acceptThreshold - nearMissBand;

    return withinBand
      ? ResolutionReviewTrigger.near_miss_rejection
      : undefined;
  }

  /**
   * The two triggers for rows where recall produced nothing at all.
   *
   * They do **not** partition the space, and that is the point. Three outcomes:
   *
   *  - The input named no brand or model → `insufficient_evidence`. Nobody can
   *    judge this from what is stored, so it blocks the AI as well as
   *    auto-accept; spending tokens on it buys nothing.
   *  - The input named both, and finding nothing is *surprising* — either the
   *    brand never resolved to a catalog brand (an alias gap), or the catalog
   *    does hold products of that brand and category → `no_candidates_but_named`.
   *  - The input named both and the catalog genuinely has nothing comparable →
   *    **no trigger**. This is an ordinary new product in a growing catalog, and
   *    it is by far the commonest shape. Firing on it would make the trigger
   *    meaningless and bury the two cases above in noise.
   *
   * None of the three can be auto-accepted regardless: the trust rule requires a
   * non-empty candidate list, and a rejection with no candidates scores 0
   * confidence (see `ResolutionConfidenceService.outcomeAgreement`).
   */
  private zeroCandidateTriggers(
    input: ReviewTriggerInput,
  ): (ResolutionReviewTrigger | undefined)[] {
    // Duplicate-detection rows always carry their one candidate, so an empty
    // list there means a malformed row, not a recall miss.
    if (input.flow !== ProductResolutionFlow.product_resolution) return [];
    if (!isEmpty(input.candidates)) return [];

    const snapshot =
      input.inputSnapshot?.kind === 'product_resolution'
        ? input.inputSnapshot
        : undefined;

    const namedBrand = snapshot?.brand?.name ?? snapshot?.input?.brand;
    const namedModel = snapshot?.input?.model;

    if (!namedBrand?.trim() || !namedModel?.trim()) {
      return [ResolutionReviewTrigger.insufficient_evidence];
    }

    // A named brand that resolved to nothing is surprising on its own — no
    // catalog lookup can tell us more than the failed resolution already did.
    const brandUnresolved = !snapshot?.brand?.id;
    const surprising =
      brandUnresolved || input.catalogHasBrandCategorySiblings === true;

    return surprising
      ? [ResolutionReviewTrigger.no_candidates_but_named]
      : [];
  }

  /** Read from the same places the matcher reads them, so a retuned
   *  `acceptThreshold` moves the gates and the triggers together rather than
   *  leaving the triggers describing a bar nobody uses any more. */
  private thresholds(): TriggerThresholds {
    const matching = this.dynamicConfigService.resolution?.matching;
    const review = this.dynamicConfigService.resolution?.review;
    const defaults = RESOLUTION_DEFAULTS;

    return {
      acceptThreshold:
        matching?.acceptThreshold ?? defaults.matching.acceptThreshold,
      ambiguityGap: matching?.ambiguityGap ?? defaults.matching.ambiguityGap,
      nearMissBand: review?.nearMissBand ?? defaults.review.nearMissBand,
      nameOnlySpecSimilarityMax:
        review?.nameOnlySpecSimilarityMax ??
        defaults.review.nameOnlySpecSimilarityMax,
    };
  }
}
