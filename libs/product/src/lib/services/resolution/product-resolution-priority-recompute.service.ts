import { Injectable } from '@nestjs/common';
import {
  OfferRepository,
  ProductResolution,
  ProductResolutionRepository,
  ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { compact, isEmpty, sumBy, uniq } from 'lodash';
import type { BlastRadius } from './product-resolution-priority.service';
import { ResolutionScoringService } from './resolution-scoring.service';

export interface ResolutionPriorityRecomputeSummary {
  rowsRescored: number;
  batches: number;
  durationMs: number;
  /** True when the run stopped on `maxRowsPerRun` with work still outstanding —
   *  the queue is being worked through across several nights. */
  capped: boolean;
}

/**
 * Rescores the review queue nightly — both `decisionConfidence` and `priority`.
 *
 * Priority goes stale for three reasons the row itself cannot notice: products
 * gain listings, weights get tuned, and rows get decided. None of them needs to
 * be seen within the second, so a nightly pass is the right granularity.
 *
 * Recomputing confidence in the same pass is what makes a separate backfill
 * unnecessary: rows written before the scoring redesign converge on the new
 * scale the first time this runs.
 *
 * The shape that matters is constant queries per batch, not per row — a load, at
 * most two grouped counts, and one bulk update, however many rows the batch
 * holds. Anything per-row here would make the sweep unusable at the scale it
 * exists for.
 */
@Injectable()
export class ProductResolutionPriorityRecomputeService {
  private readonly logger = new CustomLogger(
    ProductResolutionPriorityRecomputeService.name,
  );

  constructor(
    private readonly resolutionRepo: ProductResolutionRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly offerRepo: OfferRepository,
    private readonly scoringService: ResolutionScoringService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  public async recompute(): Promise<ResolutionPriorityRecomputeSummary> {
    const startedAt = Date.now();
    const config = this.dynamicConfigService.resolution?.priority;
    const defaults = RESOLUTION_DEFAULTS.priority;

    if (!(config?.recomputeEnabled ?? defaults.recomputeEnabled)) {
      this.logger.debug('Resolution priority recompute is disabled');
      return { rowsRescored: 0, batches: 0, durationMs: 0, capped: false };
    }

    const batchSize = config?.recomputeBatchSize ?? defaults.recomputeBatchSize;
    const maxRows = config?.maxRowsPerRun ?? defaults.maxRowsPerRun;

    // Every row this run writes gets `priorityComputedAt = now()`, which is
    // after this instant — so the cursor only ever moves forward and the loop
    // cannot see the same row twice.
    const runStartedAt = new Date();

    let rowsRescored = 0;
    let batches = 0;

    while (rowsRescored < maxRows) {
      const batch = await this.resolutionRepo.findStalePriorityBatch(
        runStartedAt,
        Math.min(batchSize, maxRows - rowsRescored),
      );
      if (isEmpty(batch)) break;

      await this.rescore(batch);
      rowsRescored += batch.length;
      batches += 1;
    }

    const summary = {
      rowsRescored,
      batches,
      durationMs: Date.now() - startedAt,
      capped: rowsRescored >= maxRows,
    };

    this.logger.log('Resolution priority recompute completed', summary);
    return summary;
  }

  private async rescore(batch: ProductResolution[]): Promise<void> {
    const blastRadii = await this.blastRadiusFor(batch);

    await this.resolutionRepo.updateScores(
      batch.map((resolution) => ({
        id: resolution.id,
        ...this.scoringService.forRow(resolution, blastRadii.get(resolution.id)),
      })),
    );
  }

  /**
   * What rides on the products each row touches, for the whole batch at once.
   *
   * Two grouped counts over the batch's distinct products, not one pair per row
   * — this is the query the sweep exists to keep constant.
   */
  private async blastRadiusFor(
    batch: ProductResolution[],
  ): Promise<Map<string, BlastRadius>> {
    const productIdsByRow = new Map(
      batch.map((resolution) => [
        resolution.id,
        this.affectedProductIds(resolution),
      ]),
    );
    const productIds = uniq([...productIdsByRow.values()].flat());

    const [listingCounts, offerCounts] = await Promise.all([
      this.sourceRecordRepo.countByModelIds(productIds),
      this.offerRepo.countByModelIds(productIds),
    ]);

    return new Map(
      [...productIdsByRow].map(([resolutionId, ids]) => [
        resolutionId,
        {
          sourceRecords: sumBy(ids, (id) => listingCounts.get(id) ?? 0),
          offers: sumBy(ids, (id) => offerCounts.get(id) ?? 0),
        },
      ]),
    );
  }

  /**
   * Which products a wrong decision here would damage.
   *
   * For a duplicate pair that is both sides — accepting it merges them, so both
   * are at stake. For a resolution it is wherever the listing actually sits plus
   * whatever the decision named; `uniq` collapses them, which is the usual case.
   */
  private affectedProductIds(resolution: ProductResolution): string[] {
    return uniq(
      compact([
        resolution.sourceRecord?.model?.id,
        resolution.resolvedProduct?.id,
        resolution.productA?.id,
        resolution.productB?.id,
      ]),
    );
  }
}
