import { Injectable } from '@nestjs/common';
import {
  ProductResolution,
  ProductResolutionFlow,
  ProductResolutionRepository,
  ProductResolutionStatus,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionDecidedBy,
  ResolutionVerdict,
  type CreateProductResolutionParams,
  type ProductResolutionDecisionEntry,
  type UpsertProductResolutionPairParams,
} from '@fittkereso-backend/database';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductResolutionFingerprintService } from './product-resolution-fingerprint.service';
import {
  ResolutionScoringService,
  type ResolutionScores,
} from './resolution-scoring.service';
import { minScoreToRecord } from './resolution-record-threshold';
import {
  deterministicAutomationConfig,
  trustRuleRejection,
} from './resolution-trust-rule';

/**
 * Single shared mechanism both the resolution flow (`libs/resolution`, via
 * `recordResolution`) and the duplicate-detection flow
 * (`ProductDuplicateEvaluationService`/`writeScrapeAmbiguousDuplicate`, via
 * `recordDuplicatePair`) write `ProductResolution` rows through. Both methods
 * share the same `resolution.minScoreToRecord` gate, so the threshold is
 * genuinely uniform across flows rather than two independently-implemented
 * checks that happen to use the same config value.
 *
 * It is also where idempotency lives: given an `anchorKey`, a repeat sighting of
 * an unchanged situation updates `lastSeenAt` instead of creating a row, so the
 * same decision is never queued for review twice.
 *
 * Lives here (not in `libs/resolution`) because `libs/product` is the common
 * dependency both `libs/resolution` and `libs/product-scraper` already have,
 * and never depends back on either — zero new module-wiring edges.
 */
@Injectable()
export class ProductResolutionRecorderService {
  private readonly logger = new CustomLogger(ProductResolutionRecorderService.name);

  constructor(
    private readonly resolutionRepo: ProductResolutionRepository,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly fingerprintService: ProductResolutionFingerprintService,
    private readonly scoringService: ResolutionScoringService,
  ) {}

  /**
   * Used by the resolution flow. With an `anchorKey` (a real scraped listing)
   * this is idempotent per listing; without one — the ad-hoc admin test
   * endpoint, which has no stable situation to key on — it stays append-only.
   */
  async recordResolution(
    params: CreateProductResolutionParams,
  ): Promise<ProductResolution | null> {
    if (!this.shouldRecordResolution(params)) return null;

    const seedDecision = this.buildResolutionSeed(params);
    const scored = this.scoringService.forRecord({ ...params, seedDecision });
    const autoAccept = this.autoAcceptFor(params, scored);

    // Rescore when the rule settles the row: `status` is the one scoring input
    // that changed, and it feeds `statusWeight`, so a row written `done` while
    // scored as `pending` would carry a priority describing a queue position it
    // never occupied. Confidence and the triggers are unaffected — status enters
    // priority only — so this is a second pass over pure arithmetic, not a
    // second look at the evidence.
    const scores = autoAccept
      ? this.scoringService.forRecord({
          ...params,
          seedDecision,
          status: ProductResolutionStatus.done,
        })
      : scored;

    if (!params.anchorKey) {
      return this.resolutionRepo.insert({
        ...params,
        ...scores,
        seedDecision,
        autoAccept,
      });
    }

    const fingerprint = this.fingerprintService.compute({
      flow: params.flow,
      anchorKey: params.anchorKey,
      candidates: params.candidates,
      decisionKind: params.decisionSnapshot?.kind,
      resolvedProductId: params.resolvedProductId,
    });

    const { resolution, outcome } = await this.resolutionRepo.upsertByAnchor({
      ...params,
      ...scores,
      anchorKey: params.anchorKey,
      fingerprint,
      seedDecision,
      autoAccept,
    });

    this.logger.debug('Recorded product resolution', {
      resolutionId: resolution.id,
      anchorKey: params.anchorKey,
      outcome,
      priority: scores.priority,
      decisionConfidence: scores.decisionConfidence,
      reviewTriggers: scores.reviewTriggers,
      autoAccepted: !!autoAccept,
    });

    return resolution;
  }

  /**
   * The record-time half of the deterministic rule — the primary call site.
   *
   * Costs nothing extra: confidence and the triggers were already computed to be
   * written on the row, so the rule is a handful of comparisons over values in
   * hand. That is the whole reason it runs here rather than only nightly — a row
   * the scores can be trusted on should never appear in the queue at all, not
   * appear and be closed a few hours later.
   *
   * `reviewedAt` is deliberately absent from the subject: this describes a
   * situation, not a stored row, and nobody can have touched a row that does not
   * exist. The refresh path checks it against the real row instead.
   *
   * In `dryRun` the verdict is logged and discarded, which is what makes the
   * first night readable: the log shows exactly which rows *would* have been
   * closed, against real traffic, before anything is closed for real.
   */
  private autoAcceptFor(
    params: CreateProductResolutionParams,
    scores: ResolutionScores,
  ): CreateProductResolutionParams['autoAccept'] {
    const config = deterministicAutomationConfig(this.dynamicConfigService);
    if (!config.enabled || !config.atRecordTime) return undefined;

    const rejection = trustRuleRejection(
      {
        flow: params.flow,
        decisionConfidence: scores.decisionConfidence,
        reviewTriggers: scores.reviewTriggers,
        candidates: params.candidates,
      },
      config,
    );

    if (rejection) return undefined;

    if (config.dryRun) {
      this.logger.log('Would auto-accept at record time (dryRun)', {
        anchorKey: params.anchorKey,
        resolvedProductId: params.resolvedProductId,
        decisionConfidence: scores.decisionConfidence,
        candidateCount: params.candidates?.length ?? 0,
      });
      return undefined;
    }

    const now = new Date().toISOString();
    return {
      decidedBy: ResolutionDecidedBy.system,
      decision: {
        at: now,
        actor: ResolutionActor.system,
        verdict: ResolutionVerdict.accept,
        // Nothing to carry out: the seed entry already performed the match or
        // the creation. This entry is the confirmation, which is exactly what
        // makes the deterministic path non-destructive.
        action: { kind: ResolutionActionKind.none },
        actionPerformed: false,
        note: `auto-accepted: confidence ${scores.decisionConfidence} ≥ ${config.minConfidence}, no review trigger fired`,
      },
    };
  }

  /** Used by the duplicate-detection flow (nightly + scrape-time ambiguous) —
   *  idempotent pair upsert, same threshold gate as `recordResolution`. */
  async recordDuplicatePair(
    params: UpsertProductResolutionPairParams,
  ): Promise<ProductResolution | null> {
    // No exemption here: a duplicate pair is a proposal about two products that
    // already exist, so a low score means the pair genuinely is not worth
    // reviewing — unlike the resolution flow, nothing was created as a result.
    if (!this.clearsThreshold(params.similarityScore)) {
      this.logSuppressed(params.similarityScore, {
        flow: params.flow,
        productAId: params.productAId,
        productBId: params.productBId,
      });
      return null;
    }

    const anchorKey = this.fingerprintService.pairAnchor(
      params.productAId,
      params.productBId,
    );
    const seedDecision = this.buildDuplicateSeed(params);

    return this.resolutionRepo.upsertPair({
      ...params,
      ...this.scoringService.forRecord({ ...params, seedDecision }),
      anchorKey,
      fingerprint: this.fingerprintService.compute({
        flow: params.flow,
        anchorKey,
        candidates: params.candidates,
      }),
      seedDecision,
    });
  }

  /**
   * The system's own decision, always the first entry in the log.
   *
   * `actionPerformed` is true because a scrape-time resolution has already taken
   * effect by the time it is recorded — the listing was matched to a product, or
   * a new one was created for it. That is what tells the review queue an accept
   * here is confirmation rather than execution.
   */
  private buildResolutionSeed(
    params: CreateProductResolutionParams,
  ): ProductResolutionDecisionEntry {
    const matched = !!params.resolvedProductId;
    const now = new Date().toISOString();

    return {
      at: now,
      actor: ResolutionActor.system,
      verdict: matched
        ? ResolutionVerdict.matched_existing
        : ResolutionVerdict.created_new,
      action: {
        // A created product has no id yet — the scraper backfills both this and
        // the sourceRecord link once persistProduct has run.
        kind: matched ? ResolutionActionKind.match : ResolutionActionKind.create,
        productId: params.resolvedProductId,
        sourceRecordIds: params.sourceRecordId
          ? [params.sourceRecordId]
          : undefined,
      },
      actionPerformed: true,
      performedAt: now,
      note: params.decisionSnapshot?.reason,
    };
  }

  /**
   * A duplicate pair is a *proposal*: the system flagged it but changed nothing,
   * so `actionPerformed` is false and accepting the row is what executes the
   * merge.
   */
  private buildDuplicateSeed(
    params: UpsertProductResolutionPairParams,
  ): ProductResolutionDecisionEntry {
    return {
      at: new Date().toISOString(),
      actor: ResolutionActor.system,
      verdict: ResolutionVerdict.duplicate_proposed,
      action: {
        kind: ResolutionActionKind.merge,
        sourceProductId: params.productAId,
        targetProductId: params.productBId,
      },
      actionPerformed: false,
      note: params.pendingReasons?.join('; '),
    };
  }

  /**
   * Whether a resolution is worth queueing for review.
   *
   * The score gate exists to keep noise out: a listing that resembled nothing in
   * the catalog is not a decision anyone needs to check. But `similarityScore`
   * falls back to `decision.confidence` when scoring produced no best candidate,
   * and an unresolved decision reports `confidence: 0` by construction — it has
   * no selected candidate to take a max over. Gating on that number would
   * silently discard exactly the rows most worth seeing: a listing the system
   * could not place, which therefore got a brand-new product of its own. Those
   * are how duplicate products enter the catalog.
   *
   * So an outcome that created a product is always recorded, however low it
   * scored. The threshold still applies to resolutions that matched an existing
   * product, where a low score really does mean "nothing interesting happened".
   */
  private shouldRecordResolution(
    params: CreateProductResolutionParams,
  ): boolean {
    if (this.clearsThreshold(params.similarityScore)) return true;

    if (!params.resolvedProductId) {
      this.logger.debug(
        'Recording low-scoring resolution: no product was matched, so this created a new one',
        {
          anchorKey: params.anchorKey,
          similarityScore: params.similarityScore,
          threshold: this.recordThreshold(),
          decisionKind: params.decisionSnapshot?.kind,
          decisionReason: params.decisionSnapshot?.reason,
        },
      );
      return true;
    }

    this.logSuppressed(params.similarityScore, {
      flow: params.flow,
      anchorKey: params.anchorKey,
      resolvedProductId: params.resolvedProductId,
      decisionKind: params.decisionSnapshot?.kind,
    });
    return false;
  }

  private clearsThreshold(score: number): boolean {
    return score >= this.recordThreshold();
  }

  private recordThreshold(): number {
    return minScoreToRecord(this.dynamicConfigService);
  }

  /**
   * A suppressed row leaves no trace anywhere else — not in the queue, not in
   * the log — which makes "why is there no record for this listing?" impossible
   * to answer without reading this file. So say so.
   */
  private logSuppressed(
    score: number,
    context: Record<string, unknown>,
  ): void {
    this.logger.debug('Resolution not recorded: below minScoreToRecord', {
      similarityScore: score,
      threshold: this.recordThreshold(),
      ...context,
    });
  }
}
