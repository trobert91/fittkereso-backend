import { Injectable } from '@nestjs/common';
import {
  ProductResolution,
  ProductResolutionRepository,
  type CreateProductResolutionParams,
  type UpsertProductResolutionPairParams,
} from '@fittkereso-backend/database';
import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';

/**
 * Single shared mechanism both the resolution flow (`libs/resolution`, via
 * `recordResolution`) and the duplicate-detection flow
 * (`ProductDuplicateEvaluationService`/`writeScrapeAmbiguousDuplicate`, via
 * `recordDuplicatePair`) write `ProductResolution` rows through. Both methods
 * share the same `resolution.minScoreToRecord` gate, so the threshold is
 * genuinely uniform across flows rather than two independently-implemented
 * checks that happen to use the same config value.
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
  ) {}

  /** Used by the resolution flow — always-insert (append-only decision log). */
  async recordResolution(
    params: CreateProductResolutionParams,
  ): Promise<ProductResolution | null> {
    if (!this.clearsThreshold(params.similarityScore)) return null;
    return this.resolutionRepo.insert(params);
  }

  /** Used by the duplicate-detection flow (nightly + scrape-time ambiguous) —
   *  idempotent pair upsert, same threshold gate as `recordResolution`. */
  async recordDuplicatePair(
    params: UpsertProductResolutionPairParams,
  ): Promise<ProductResolution | null> {
    if (!this.clearsThreshold(params.similarityScore)) return null;
    return this.resolutionRepo.upsertPair(params);
  }

  private clearsThreshold(score: number): boolean {
    const threshold =
      this.dynamicConfigService.resolution?.minScoreToRecord ??
      RESOLUTION_DEFAULTS.minScoreToRecord;
    return score >= threshold;
  }
}
