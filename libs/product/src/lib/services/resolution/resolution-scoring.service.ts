import { Injectable } from '@nestjs/common';
import {
  ProductResolution,
  ProductResolutionFlow,
  ProductResolutionStatus,
  type ProductResolutionCandidateRecord,
  type ProductResolutionDecisionEntry,
  type ProductResolutionDecisionSnapshot,
  type ResolutionPriorityBreakdown,
  type SpecMatchDetails,
} from '@fittkereso-backend/database';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { isEmpty, isNumber, orderBy } from 'lodash';
import {
  ProductResolutionPriorityService,
  type BlastRadius,
  type ProductResolutionPriorityParams,
} from './product-resolution-priority.service';
import { findLastPerformedDecision } from './resolution-decision-log';
import { minScoreToRecord } from './resolution-record-threshold';

/**
 * The scores a `ProductResolution` row carries, keyed by their column names so
 * writers can spread this straight into a persist call rather than restating the
 * mapping — twice, differently, in two places.
 */
export interface ResolutionScores {
  decisionConfidence: number;
  priority: number;
  priorityBreakdown: ResolutionPriorityBreakdown;
}

/** What a row that does not exist yet can say about itself. */
export interface RecordScoringInput {
  flow: ProductResolutionFlow;
  similarityScore: number;
  resolvedProductId?: string;
  candidates?: ProductResolutionCandidateRecord[];
  specMatchDetails?: SpecMatchDetails;
  decisionSnapshot?: ProductResolutionDecisionSnapshot;
  /** The producing system's own decision — index 0 of the log-to-be. */
  seedDecision?: ProductResolutionDecisionEntry;
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
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  /** At record time. Deliberately query-free: this runs on the scrape hot path,
   *  once per resolved listing. */
  public forRecord(input: RecordScoringInput): ResolutionScores {
    return this.score({
      ...this.sharedParams(input),
      seedVerdict: input.seedDecision?.verdict,
      // Every row is written `pending`, and written the moment its situation was
      // seen — so neither the status weight nor the staleness taper has anything
      // to say about it yet.
      status: ProductResolutionStatus.pending,
      lastPerformed: input.seedDecision?.actionPerformed
        ? input.seedDecision
        : undefined,
      // Counting the listings on the affected product would cost a query per
      // scraped record. Left unmeasured on purpose; the sweep fills it in, and
      // `blastRadiusMeasured` records that it did.
      blastRadius: undefined,
    });
  }

  /** At sweep time, from a persisted row. `blastRadius` comes from the sweep's
   *  batch-wide grouped counts, so this stays query-free too. */
  public forRow(
    resolution: ProductResolution,
    blastRadius?: BlastRadius,
  ): ResolutionScores {
    return this.score({
      ...this.sharedParams({
        flow: resolution.flow,
        similarityScore: resolution.similarityScore,
        // Unreliable after persistence — the scraper backfills it for created
        // products too — so it is only ever the fallback for a row with no seed
        // entry. See `deriveSystemAssertion`.
        resolvedProductId: resolution.resolvedProduct?.id,
        candidates: resolution.candidates,
        specMatchDetails: resolution.specMatchDetails,
        decisionSnapshot: resolution.decisionSnapshot,
      }),
      seedVerdict: resolution.decisions?.[0]?.verdict,
      status: resolution.status,
      lastPerformed: findLastPerformedDecision(resolution.decisions),
      lastSeenAt: resolution.lastSeenAt,
      blastRadius,
    });
  }

  private score(
    params: ProductResolutionPriorityParams,
  ): ResolutionScores {
    const breakdown = this.priorityService.explain(params);

    return {
      decisionConfidence: breakdown.confidence,
      priority: breakdown.priority,
      priorityBreakdown: breakdown,
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
      scoring: this.scoringFrom(input.candidates),
      floor: this.floorFor(input.flow),
      // The one place config reaches the scoring calculation. Both pure
      // services take their weights as parameters, so this service owns the
      // dependency and they stay testable without one.
      weights: this.dynamicConfigService.resolution?.priority?.weights?.confidence,
      impactWeights: this.dynamicConfigService.resolution?.priority?.weights?.impact,
    };
  }

  /**
   * The top two candidate scores, read off the candidates rather than taken from
   * the resolution pipeline's in-memory `scoring`.
   *
   * That context is not persisted, so the sweep could not see it — and a margin
   * that existed at record time but not afterwards would make the two paths
   * disagree. `candidates[].matchScore` is stored, and carries the same numbers.
   */
  private scoringFrom(
    candidates?: ProductResolutionCandidateRecord[],
  ): { bestScore?: number; secondScore?: number } | undefined {
    if (isEmpty(candidates)) return undefined;

    // `compact` is wrong here — a candidate that scored 0 is a real runner-up,
    // and dropping it would read as "no second candidate" and silently remove
    // the margin component.
    const scores = orderBy(
      (candidates ?? [])
        .map((candidate) => candidate.matchScore)
        .filter(isNumber),
      [(score) => score],
      ['desc'],
    );

    return { bestScore: scores[0], secondScore: scores[1] };
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
