import { Injectable } from '@nestjs/common';
import {
  ProductResolution,
  ProductResolutionFlow,
  ProductResolutionStatus,
  type ProductDuplicateDetectionInputSnapshot,
  type ProductResolutionCandidateRecord,
  type ProductResolutionDecisionEntry,
  type ProductResolutionDecisionSnapshot,
  type ProductResolutionInputSnapshot,
  type ResolutionPriorityBreakdown,
  type ResolutionReviewTrigger,
  type ResolutionVerdict,
  type SpecMatchDetails,
} from '@fittkereso-backend/database';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import {
  ProductResolutionPriorityService,
  type BlastRadius,
  type ProductResolutionPriorityParams,
} from './product-resolution-priority.service';
import { findLastPerformedDecision } from './resolution-decision-log';
import { minScoreToRecord } from './resolution-record-threshold';
import {
  ResolutionReviewTriggerService,
  type ReviewTriggerInput,
} from './resolution-review-trigger.service';
import { topTwoScores } from './resolution-subject-candidate';

/**
 * The derived values a `ProductResolution` row carries, keyed by their column
 * names so writers can spread this straight into a persist call rather than
 * restating the mapping — twice, differently, in two places.
 *
 * `reviewTriggers` rides along here rather than getting a computation path of its
 * own. It is derived from exactly the same evidence as the scores and has to be
 * written by exactly the same set of callers, so bundling it means `insert`,
 * `refreshInPlace`, `upsertPair` and the sweep's `updateScores` all carry it with
 * no new call site — and no way for one of them to be forgotten.
 */
export interface ResolutionScores {
  decisionConfidence: number;
  priority: number;
  priorityBreakdown: ResolutionPriorityBreakdown;
  reviewTriggers: ResolutionReviewTrigger[];
}

/** What a row that does not exist yet can say about itself. */
export interface RecordScoringInput {
  flow: ProductResolutionFlow;
  similarityScore: number;
  resolvedProductId?: string;
  candidates?: ProductResolutionCandidateRecord[];
  specMatchDetails?: SpecMatchDetails;
  decisionSnapshot?: ProductResolutionDecisionSnapshot;
  inputSnapshot?:
    | ProductResolutionInputSnapshot
    | ProductDuplicateDetectionInputSnapshot;
  /**
   * Does the catalog hold any product of this row's brand and category?
   *
   * Read by two things that must not disagree: the `no_candidates_but_named`
   * trigger, and `outcomeAgreement`'s decision about whether an empty candidate
   * pool is explainable. Costs a query, so it is supplied by the nightly sweep
   * from a batch-wide lookup and left unset on the scrape hot path.
   */
  catalogHasBrandCategorySiblings?: boolean;
  /** The producing system's own decision — index 0 of the log-to-be. */
  seedDecision?: ProductResolutionDecisionEntry;
  /** The status the row will be written with. Defaults to `pending`, which is
   *  every row that enters the queue; the deterministic trust rule passes `done`
   *  so a row it settles is scored against the position it will actually hold
   *  rather than one it never occupies. */
  status?: ProductResolutionStatus;
}

/**
 * Turns a resolution — however the caller happens to hold it — into the scores
 * stored on it.
 *
 * Two callers need this: the recorder, from params about to be written, and the
 * nightly sweep, from a row already in the table. They must produce the same
 * number for the same situation, or a row's rank would jump the first time the
 * sweep touched it for no reason a reviewer could see. One service with two
 * entry points is what makes that structural rather than a convention.
 *
 * `priorityService.explain()` already carries the confidence it derived from, so
 * both scores come out of a single pass.
 */
@Injectable()
export class ResolutionScoringService {
  constructor(
    private readonly priorityService: ProductResolutionPriorityService,
    private readonly triggerService: ResolutionReviewTriggerService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  /**
   * At record time. Deliberately query-free: this runs on the scrape hot path,
   * once per resolved listing.
   *
   * That is also why `catalogHasBrandCategorySiblings` is left unset here — it
   * costs a query, so `no_candidates_but_named` cannot fire until the sweep runs.
   * Nothing depends on it firing immediately: the row is not auto-acceptable
   * either way (no candidates), and it is not AI-eligible until classified.
   */
  public forRecord(input: RecordScoringInput): ResolutionScores {
    const seedVerdict = input.seedDecision?.verdict;

    return this.score(
      {
        ...this.sharedParams(input),
        seedVerdict,
        // Written the moment its situation was seen, so the staleness taper has
        // nothing to say about it yet. `pending` unless the trust rule settled
        // it, which is the one case where a row is born already decided.
        status: input.status ?? ProductResolutionStatus.pending,
        lastPerformed: input.seedDecision?.actionPerformed
          ? input.seedDecision
          : undefined,
        // Counting the listings on the affected product would cost a query per
        // scraped record. Left unmeasured on purpose; the sweep fills it in, and
        // `blastRadiusMeasured` records that it did.
        blastRadius: undefined,
      },
      this.triggerInput(input, seedVerdict),
    );
  }

  /** At sweep time, from a persisted row. `blastRadius` and
   *  `catalogHasBrandCategorySiblings` both come from the sweep's batch-wide
   *  grouped counts, so this stays query-free too. */
  public forRow(
    resolution: ProductResolution,
    blastRadius?: BlastRadius,
    catalogHasBrandCategorySiblings?: boolean,
  ): ResolutionScores {
    const seedVerdict = resolution.decisions?.[0]?.verdict;
    const asRecord: RecordScoringInput = {
      flow: resolution.flow,
      similarityScore: resolution.similarityScore,
      // Unreliable after persistence — the scraper backfills it for created
      // products too — so it is only ever the fallback for a row with no seed
      // entry. See `deriveSystemAssertion`.
      resolvedProductId: resolution.resolvedProduct?.id,
      candidates: resolution.candidates,
      specMatchDetails: resolution.specMatchDetails,
      decisionSnapshot: resolution.decisionSnapshot,
      inputSnapshot: resolution.inputSnapshot,
      catalogHasBrandCategorySiblings,
    };

    return this.score(
      {
        ...this.sharedParams(asRecord),
        seedVerdict,
        status: resolution.status,
        lastPerformed: findLastPerformedDecision(resolution.decisions),
        lastSeenAt: resolution.lastSeenAt,
        blastRadius,
      },
      this.triggerInput(asRecord, seedVerdict),
    );
  }

  private score(
    params: ProductResolutionPriorityParams,
    triggerInput: ReviewTriggerInput,
  ): ResolutionScores {
    const breakdown = this.priorityService.explain(params);

    return {
      decisionConfidence: breakdown.confidence,
      priority: breakdown.priority,
      priorityBreakdown: breakdown,
      reviewTriggers: this.triggerService.triggersFor(triggerInput),
    };
  }

  /** The same evidence the scores are derived from, in the shape the trigger
   *  service reads it. Built from `RecordScoringInput` so both entry points
   *  classify from identical inputs. */
  private triggerInput(
    input: RecordScoringInput,
    seedVerdict?: ResolutionVerdict,
  ): ReviewTriggerInput {
    return {
      flow: input.flow,
      seedVerdict,
      resolvedProductId: input.resolvedProductId,
      candidates: input.candidates,
      specMatchDetails: input.specMatchDetails,
      decisionSnapshot: input.decisionSnapshot,
      inputSnapshot: input.inputSnapshot,
      catalogHasBrandCategorySiblings: input.catalogHasBrandCategorySiblings,
    };
  }

  private sharedParams(
    input: RecordScoringInput,
  ): Omit<ProductResolutionPriorityParams, 'status'> {
    return {
      flow: input.flow,
      similarityScore: input.similarityScore,
      resolvedProductId: input.resolvedProductId,
      candidates: input.candidates,
      specMatchDetails: input.specMatchDetails,
      decisionSnapshot: input.decisionSnapshot,
      catalogHasBrandCategorySiblings: input.catalogHasBrandCategorySiblings,
      scoring: topTwoScores(input.candidates),
      floor: this.floorFor(input.flow),
      // The one place config reaches the scoring calculation. Both pure
      // services take their weights as parameters, so this service owns the
      // dependency and they stay testable without one.
      weights: this.dynamicConfigService.resolution?.priority?.weights?.confidence,
      impactWeights: this.dynamicConfigService.resolution?.priority?.weights?.impact,
    };
  }

  /**
   * Only the duplicate flow's scores are truncated by the recording threshold.
   *
   * A resolution that matched nothing is recorded however low it scored (the
   * created-product exemption in `ProductResolutionRecorderService`), so that
   * flow's distribution runs the full range and rescaling it would exaggerate
   * every score. Every recorded pair, by contrast, cleared the gate.
   */
  private floorFor(flow: ProductResolutionFlow): number {
    return flow === ProductResolutionFlow.duplicate_detection
      ? minScoreToRecord(this.dynamicConfigService)
      : 0;
  }
}
