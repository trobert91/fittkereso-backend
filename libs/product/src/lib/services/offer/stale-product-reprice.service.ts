import { Injectable } from '@nestjs/common';
import {
  AdvisoryLockService,
  OfferRepository,
  ProductModelRepository,
  productLock,
} from '@fittkereso-backend/database';
import { OfferFreshnessService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductMergeService } from '../merge/product-merge.service';

/**
 * Recomputes the price of every product whose stored price is no longer its
 * cheapest fresh offer's.
 *
 * An offer that goes stale stops counting for its product's price
 * (recomputePrice only reads fresh offers), but nothing writes the product
 * when that happens: no import touches it, because no source listed it. This
 * is the step that does, once a night — so a product whose cheapest offer went
 * stale takes the next fresh one's price, or none.
 *
 * No per-run limit: the query returns only products that differ, and each one
 * is a lookup and a single-row write.
 */
@Injectable()
export class StaleProductRepriceService {
  private readonly logger = new CustomLogger(StaleProductRepriceService.name);

  constructor(
    private readonly offerRepo: OfferRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly offerFreshness: OfferFreshnessService,
    private readonly mergeService: ProductMergeService,
    private readonly locks: AdvisoryLockService,
  ) {}

  /** Returns how many products were repriced. */
  public async reprice(): Promise<number> {
    const modelIds = await this.offerRepo.findModelIdsToReprice(
      this.offerFreshness.visibleCutoff(),
    );

    let repriced = 0;
    // One product failing must not abandon the rest — each is independent.
    // Each is reloaded and saved under its lock, so an import writing to it
    // meanwhile is not overwritten with a copy loaded before.
    for (const modelId of modelIds) {
      try {
        const found = await this.locks.withLocks([productLock(modelId)], async () => {
          const model = await this.productRepo.findOne({ where: { id: modelId } });
          if (!model) return false;
          await this.mergeService.recomputePrice(model);
          await this.productRepo.save(model);
          return true;
        });
        if (found) repriced += 1;
      } catch (error) {
        this.logger.error('Failed to reprice a product after its offers went stale', error, {
          modelId,
        });
      }
    }
    return repriced;
  }
}
