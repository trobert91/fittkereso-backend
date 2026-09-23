import { Injectable } from '@nestjs/common';
import {
  OfferRepository,
  ProductModel,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { OfferFreshnessService } from './offer-freshness.service';
import { ProductMergeService } from '../merge/product-merge.service';

/**
 * Most offers this may delete in one run.
 *
 * A cap rather than a ratio guard: the 14-day window is itself the safety
 * margin — two weeks of a source failing to stamp anything before a single row
 * is at risk — so this exists to bound blast radius and DB load per run, not to
 * second-guess the evidence. Whatever is left over is picked up on the next run.
 */
export const STALE_OFFER_SWEEP_MAX_DELETIONS_PER_RUN = 500;

export interface StaleOfferSweepResult {
  deleted: number;
  modelsRecomputed: number;
  cutoff: Date;
  /** True when the per-run cap was hit and more remain for the next run. */
  capped: boolean;
}

/**
 * Deletes offers nothing has confirmed for `offers.deleteAfterDays`.
 *
 * This is the entire delisting mechanism. There are no miss counters, no
 * per-record evidence grading and no separate gone-sweep: an import run stamps
 * what it sees, and anything it stops stamping ages out of visibility first and
 * out of the database second.
 *
 * Deletion is hard, matching the in-pass sweep in
 * ProductScrapeUpdaterService.createOrUpdateOffers. Offer.active is not used —
 * nothing in production ever sets it to false.
 */
@Injectable()
export class StaleOfferSweepService {
  private readonly logger = new CustomLogger(StaleOfferSweepService.name);

  constructor(
    private readonly offerRepo: OfferRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly offerFreshness: OfferFreshnessService,
    private readonly mergeService: ProductMergeService,
  ) {}

  public async sweep(): Promise<StaleOfferSweepResult> {
    const cutoff = this.offerFreshness.deleteCutoff();

    const stale = await this.offerRepo.findStaleForDeletion(
      cutoff,
      STALE_OFFER_SWEEP_MAX_DELETIONS_PER_RUN,
    );

    if (stale.length === 0) {
      this.logger.debug('Stale offer sweep: nothing to delete', { cutoff });
      return { deleted: 0, modelsRecomputed: 0, cutoff, capped: false };
    }

    // Collected BEFORE the delete — the offers carry the only reference back to
    // their products, and after the delete there is nothing left to ask.
    const affectedModelIds = [
      ...new Set(stale.map((offer) => offer.model?.id).filter(Boolean)),
    ] as string[];

    const capped = stale.length === STALE_OFFER_SWEEP_MAX_DELETIONS_PER_RUN;

    // Dry run unless explicitly enabled. The sweep's premise is that imports
    // ARE running — an offer is only "gone" because a run that happened stopped
    // confirming it. Where nothing imports, absence of evidence is not evidence
    // of absence, and enabling this would destroy the catalog on a schedule.
    if (!this.offerFreshness.deletionEnabled) {
      this.logger.warn(
        'Stale offer sweep: deletion DISABLED — would have deleted offers',
        {
          wouldDelete: stale.length,
          cutoff,
          deleteAfterDays: this.offerFreshness.deleteAfterDays,
          affectedModels: affectedModelIds.length,
          capped,
          hint: 'Set offers.deletionEnabled once imports have been running for a full deleteAfterDays window.',
        },
      );

      return { deleted: 0, modelsRecomputed: 0, cutoff, capped };
    }

    this.logger.warn('Stale offer sweep: deleting offers', {
      count: stale.length,
      cutoff,
      deleteAfterDays: this.offerFreshness.deleteAfterDays,
      affectedModels: affectedModelIds.length,
      capped,
    });

    await this.offerRepo.deleteByIds(stale.map((offer) => offer.id));

    const modelsRecomputed = await this.recomputeAffectedModels(
      affectedModelIds,
    );

    return {
      deleted: stale.length,
      modelsRecomputed,
      cutoff,
      capped,
    };
  }

  /**
   * Recompute each affected product's denormalized price.
   *
   * Necessary rather than tidy: ProductModel.price is what the public listing
   * sorts and filters on, and recomputePrice normally only runs on a scrape
   * pass. Without this, a product whose last offer was just deleted keeps
   * advertising that offer's price indefinitely.
   *
   * One product failing must not abandon the rest — each is independent.
   */
  private async recomputeAffectedModels(modelIds: string[]): Promise<number> {
    let recomputed = 0;

    for (const modelId of modelIds) {
      try {
        const model = await this.productRepo.findOne({
          where: { id: modelId },
        });
        if (!model) continue;

        await this.mergeService.recomputePrice(model);
        await this.productRepo.save(model as ProductModel);
        recomputed += 1;
      } catch (error) {
        this.logger.error('Failed to recompute price after sweep', error, {
          modelId,
        });
      }
    }

    return recomputed;
  }
}
