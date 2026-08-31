import { Injectable } from '@nestjs/common';
import {
  ProductResolution,
  ProductResolutionFlow,
  ProductResolutionRepository,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionVerdict,
  type CreateProductResolutionParams,
  type ProductResolutionDecisionEntry,
  type UpsertProductResolutionPairParams,
} from '@fittkereso-backend/database';
import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductResolutionFingerprintService } from './product-resolution-fingerprint.service';

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

    if (!params.anchorKey) {
      return this.resolutionRepo.insert({ ...params, seedDecision });
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
      anchorKey: params.anchorKey,
      fingerprint,
      decisionConfidence:
        params.decisionConfidence ?? params.decisionSnapshot?.confidence,
      seedDecision,
    });

    this.logger.debug('Recorded product resolution', {
      resolutionId: resolution.id,
      anchorKey: params.anchorKey,
      outcome,
    });

    return resolution;
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

    return this.resolutionRepo.upsertPair({
      ...params,
      anchorKey,
      fingerprint: this.fingerprintService.compute({
        flow: params.flow,
        anchorKey,
        candidates: params.candidates,
      }),
      seedDecision: this.buildDuplicateSeed(params),
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
    return (
      this.dynamicConfigService.resolution?.minScoreToRecord ??
      RESOLUTION_DEFAULTS.minScoreToRecord
    );
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
