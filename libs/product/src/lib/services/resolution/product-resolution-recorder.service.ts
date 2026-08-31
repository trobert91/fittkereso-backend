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
    if (!this.clearsThreshold(params.similarityScore)) return null;

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
    if (!this.clearsThreshold(params.similarityScore)) return null;

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

  private clearsThreshold(score: number): boolean {
    const threshold =
      this.dynamicConfigService.resolution?.minScoreToRecord ??
      RESOLUTION_DEFAULTS.minScoreToRecord;
    return score >= threshold;
  }
}
