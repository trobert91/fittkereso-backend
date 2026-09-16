import { Injectable } from '@nestjs/common';
import { isEmpty } from 'lodash';
import {
  ProductDuplicatePairRepository,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductDuplicateService } from './product-duplicate.service';
import {
  SCAN_BUDGET_MS,
  SCAN_PAGE_SIZE,
  STALE_PAIR_GRACE_MS,
} from './product-identity.constants';

export interface DuplicateScanSummary {
  processed: number;
  pairsWritten: number;
  staleRemoved: number;
  durationMs: number;
  /** True when the time budget ran out before every product was scanned. */
  budgetHit: boolean;
}

/**
 * The nightly pass that looks for duplicates among all products, so pairs
 * appear for products that were never rescraped and disappear once they no
 * longer look alike.
 */
@Injectable()
export class ProductDuplicateScanService {
  private readonly logger = new CustomLogger(ProductDuplicateScanService.name);
  private running = false;

  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly pairRepo: ProductDuplicatePairRepository,
    private readonly duplicateService: ProductDuplicateService,
  ) {}

  /**
   * Starts a scan in the background and says whether it started: false means
   * one is already running in this process. Two processes overlapping is
   * harmless — the writes are idempotent and ordered.
   */
  public start(): boolean {
    if (this.running) return false;
    this.running = true;

    void this.run()
      .catch((error: unknown) => {
        this.logger.error('Duplicate scan failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.running = false;
      });

    return true;
  }

  public isRunning(): boolean {
    return this.running;
  }

  /**
   * One pass over every product. A product that fails is logged and skipped —
   * one bad row can't stop the scan. A **complete** pass then deletes open
   * pairs it didn't re-find, so recalibration and product edits don't leave
   * stale suggestions behind; a pass that ran out of budget deletes nothing,
   * since it never looked at the rest of the catalog. Dismissed pairs stay.
   */
  public async run(): Promise<DuplicateScanSummary> {
    const startedAt = Date.now();
    const deadline = startedAt + SCAN_BUDGET_MS;
    let processed = 0;
    let pairsWritten = 0;
    let budgetHit = false;

    for (let skip = 0; !budgetHit; skip += SCAN_PAGE_SIZE) {
      const page = await this.productRepo.find({
        select: { id: true },
        order: { id: 'ASC' },
        take: SCAN_PAGE_SIZE,
        skip,
      });
      if (isEmpty(page)) break;

      for (const product of page) {
        if (Date.now() > deadline) {
          budgetHit = true;
          break;
        }
        try {
          pairsWritten += await this.duplicateService.detect(product.id, 'scan');
        } catch (error: unknown) {
          this.logger.warn('Duplicate detection failed for product', {
            productId: product.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        processed++;
      }
    }

    const staleRemoved = budgetHit
      ? 0
      : await this.pairRepo.deleteStaleOpenPairs(
          new Date(startedAt - STALE_PAIR_GRACE_MS),
        );

    const summary: DuplicateScanSummary = {
      processed,
      pairsWritten,
      staleRemoved,
      durationMs: Date.now() - startedAt,
      budgetHit,
    };
    this.logger.log('Duplicate scan finished', summary);
    return summary;
  }
}
