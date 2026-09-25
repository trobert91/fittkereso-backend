import { Injectable } from '@nestjs/common';
import {
  AdvisoryLockService,
  Offer,
  OfferRepository,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  Seller,
  productLock,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { compact, groupBy, uniq } from 'lodash';
import { OfferFreshnessService } from './offer-freshness.service';
import { ProductMergeService } from '../merge/product-merge.service';
import { nameOf, storedOfferExternalId } from '@fittkereso-backend/utils';
import {
  OFFER_COMPOSER_MODEL_RELATIONS,
  OfferComposerService,
} from './offer-composer.service';
import { ContributorDetachService } from './contributor-detach.service';

/**
 * Most offers this may delete in one run.
 *
 * A cap rather than a ratio guard: the 14-day window is itself the safety
 * margin — two weeks of a source failing to stamp anything before a single row
 * is at risk — so this exists to bound blast radius and DB load per run, not to
 * second-guess the evidence. Whatever is left over is picked up on the next run.
 */
export const STALE_OFFER_SWEEP_MAX_DELETIONS_PER_RUN = 500;

/** Most products whose offers one run composes again after a source dropped them. */
export const STALE_CONTRIBUTOR_MAX_PRODUCTS_PER_RUN = 500;

export interface StaleOfferSweepResult {
  /**
   * Products whose offers were composed again because one of a seller's
   * sources stopped listing them while another still does.
   */
  contributorsRecomposed: number;
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
 *
 * Before deleting, it composes again the offers one of a seller's sources has
 * stopped listing while another still does: the dropping source's values stop
 * counting, and the offer lives on with the other's. That does not depend on
 * deletion being enabled.
 *
 * After deleting, the contributing records that joined a deleted offer, and
 * joined nothing else on the product, are detached (ContributorDetachService).
 */
@Injectable()
export class StaleOfferSweepService {
  private readonly logger = new CustomLogger(StaleOfferSweepService.name);

  constructor(
    private readonly offerRepo: OfferRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly offerFreshness: OfferFreshnessService,
    private readonly mergeService: ProductMergeService,
    private readonly locks: AdvisoryLockService,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly offerComposer: OfferComposerService,
    private readonly contributorDetach: ContributorDetachService,
  ) {}

  public async sweep(): Promise<StaleOfferSweepResult> {
    const contributorsRecomposed = await this.recomposeStaleContributors();
    return { contributorsRecomposed, ...(await this.deleteStale()) };
  }

  /**
   * The products where a seller's source has stopped listing an offer another
   * of its sources still lists — each picked up on the nightly runs between
   * the record leaving the visible window and the delete cutoff. Every offer of
   * the product is composed again, without lastSynced: the sources that still
   * list it keep stamping it themselves.
   */
  private async recomposeStaleContributors(): Promise<number> {
    const modelIds = await this.sourceRecordRepo.findModelIdsWithStaleContributors({
      visibleCutoff: this.offerFreshness.visibleCutoff(),
      deleteCutoff: this.offerFreshness.deleteCutoff(),
      limit: STALE_CONTRIBUTOR_MAX_PRODUCTS_PER_RUN,
    });

    let recomposed = 0;
    for (const modelId of modelIds) {
      try {
        const found = await this.locks.withLocks([productLock(modelId)], () =>
          this.recompose(modelId),
        );
        if (found) recomposed += 1;
      } catch (error) {
        this.logger.error('Failed to compose offers after a source dropped them', error, {
          modelId,
        });
      }
    }
    if (recomposed > 0) {
      this.logger.log('Stale offer sweep: composed offers a source stopped listing', {
        products: recomposed,
      });
    }
    return recomposed;
  }

  private async recompose(modelId: string): Promise<boolean> {
    const model = await this.productRepo.findOne({
      where: { id: modelId },
      relations: OFFER_COMPOSER_MODEL_RELATIONS,
    });
    if (!model) return false;

    for (const { seller, externalIds } of this.offersBySeller(model.sources ?? [])) {
      const { conflicts } = await this.offerComposer.compose({
        model,
        seller,
        externalIds,
        sighted: false,
        create: false,
      });
      if (conflicts.length > 0) {
        this.logger.warn('Stale offer sweep: an offer sits on another product', {
          modelId,
          offerIds: conflicts.map((conflict) => conflict.details.offerId),
        });
      }
    }
    await this.mergeService.recomputePrice(model);
    await this.productRepo.save(model);
    return true;
  }

  /** Every offer a product's records carry, per seller. */
  private offersBySeller(
    records: ProductSourceRecord[],
  ): { seller: Seller; externalIds: string[] }[] {
    const bySeller = new Map<string, { seller: Seller; externalIds: string[] }>();
    for (const record of records) {
      const seller = record.source?.seller;
      if (!seller) continue;
      const group = bySeller.get(seller.id) ?? { seller, externalIds: [] };
      group.externalIds.push(
        ...compact(
          (record.scrapedProduct?.offers ?? []).map((entry) =>
            storedOfferExternalId(record, entry),
          ),
        ),
      );
      bySeller.set(seller.id, group);
    }
    return [...bySeller.values()].map((group) => ({
      ...group,
      externalIds: uniq(group.externalIds),
    }));
  }

  private async deleteStale(): Promise<Omit<StaleOfferSweepResult, 'contributorsRecomposed'>> {
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
    const removedByModel = this.removedKeysByModel(stale);
    const affectedModelIds = [...removedByModel.keys()];

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

    const modelsRecomputed = await this.recomputeAffectedModels(removedByModel);

    return {
      deleted: stale.length,
      modelsRecomputed,
      cutoff,
      capped,
    };
  }

  /** Per product, the deleted offers' keys, per seller. */
  private removedKeysByModel(
    offers: Offer[],
  ): Map<string, { sellerId: string; externalIds: string[] }[]> {
    const byModel = new Map<string, { sellerId: string; externalIds: string[] }[]>();
    for (const [modelId, modelOffers] of Object.entries(
      groupBy(
        offers.filter((offer) => offer.model?.id),
        (offer) => offer.model.id,
      ),
    )) {
      byModel.set(
        modelId,
        Object.entries(groupBy(modelOffers, (offer) => offer.seller?.id)).flatMap(
          ([sellerId, sellerOffers]) =>
            sellerOffers[0].seller
              ? [{ sellerId, externalIds: compact(sellerOffers.map((offer) => offer.externalId)) }]
              : [],
        ),
      );
    }
    return byModel;
  }

  /**
   * Detach what joined the deleted offers, and recompute each affected
   * product's denormalized price.
   *
   * Necessary rather than tidy: ProductModel.price is what the public listing
   * sorts and filters on, and recomputePrice normally only runs on a scrape
   * pass. Without this, a product whose last offer was just deleted keeps
   * advertising that offer's price indefinitely.
   *
   * One product failing must not abandon the rest — each is independent.
   * Each is reloaded and saved under its lock, so an import writing to it
   * meanwhile is not overwritten with a copy loaded before.
   */
  private async recomputeAffectedModels(
    removedByModel: Map<string, { sellerId: string; externalIds: string[] }[]>,
  ): Promise<number> {
    let recomputed = 0;

    for (const [modelId, removed] of removedByModel) {
      try {
        const found = await this.locks.withLocks(
          [productLock(modelId)],
          async () => {
            const model = await this.productRepo.findOne({
              where: { id: modelId },
              relations: [
                ...OFFER_COMPOSER_MODEL_RELATIONS,
                nameOf<ProductModel>('productCategory'),
              ],
            });
            if (!model) return false;

            for (const { sellerId, externalIds } of removed) {
              await this.contributorDetach.detach({ model, sellerId, externalIds });
            }
            await this.mergeService.recomputePrice(model);
            await this.productRepo.save(model as ProductModel);
            return true;
          },
        );
        if (found) recomputed += 1;
      } catch (error) {
        this.logger.error('Failed to recompute price after sweep', error, {
          modelId,
        });
      }
    }

    return recomputed;
  }
}
