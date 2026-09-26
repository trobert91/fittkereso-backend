import { Injectable } from '@nestjs/common';
import {
  AdvisoryLockService,
  Offer,
  OfferRepository,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ProductSourceRepository,
  Seller,
  productLock,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { compact, groupBy, sumBy, uniq } from 'lodash';
import ms from 'ms';
import { OfferFreshnessService } from '@fittkereso-backend/dynamic-config';
import { ProductMergeService } from '../merge/product-merge.service';
import { nameOf, storedOfferExternalId } from '@fittkereso-backend/utils';
import {
  OFFER_COMPOSER_MODEL_RELATIONS,
  OfferComposerService,
} from './offer-composer.service';
import { ContributorDetachService } from './contributor-detach.service';
import { StaleProductRepriceService } from './stale-product-reprice.service';

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
  /** Products whose price changed because their cheapest offer went stale. */
  productsRepriced: number;
  deleted: number;
  modelsRecomputed: number;
  /**
   * Offers past the delete cutoff kept because nothing of their seller was
   * confirmed recently (see OfferRepository.findStaleForDeletion).
   */
  keptForSilentSellers: number;
  cutoff: Date;
  /** True when the per-run cap was hit and more remain for the next run. */
  capped: boolean;
}

/**
 * The nightly offer lifecycle: an offer nothing has confirmed for
 * `offers.freshnessDays` stops setting its product's price, and one nothing
 * has confirmed for `offers.deleteAfterDays` is deleted.
 *
 * This is the entire delisting mechanism. There are no miss counters, no
 * per-record evidence grading and no separate gone-sweep: an import run stamps
 * what it sees, and anything it stops stamping ages out of visibility first and
 * out of the database second.
 *
 * In order:
 * 1. It composes again the offers one of a seller's sources has stopped
 *    listing while another still does: the dropping source's values stop
 *    counting, and the offer lives on with the other's.
 * 2. It reprices the products whose cheapest offer went stale
 *    (StaleProductRepriceService).
 * 3. It deletes the offers past the delete cutoff — only of sellers some import
 *    still confirms, and only while `offers.deletionEnabled` is on. Deletion is
 *    hard, matching the in-pass sweep in
 *    ProductScrapeUpdaterService.createOrUpdateOffers. The contributing records
 *    that joined a deleted offer, and joined nothing else on the product, are
 *    detached (ContributorDetachService).
 *
 * It also warns about scheduled sources that run less often than offers go
 * stale: their offers would drop out of their products' prices between runs.
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
    private readonly reprice: StaleProductRepriceService,
    private readonly sourceRepo: ProductSourceRepository,
  ) {}

  public async sweep(): Promise<StaleOfferSweepResult> {
    await this.warnAboutSlowSources();
    const contributorsRecomposed = await this.recomposeStaleContributors();
    const productsRepriced = await this.reprice.reprice();
    return { contributorsRecomposed, productsRepriced, ...(await this.deleteStale()) };
  }

  /**
   * A scheduled source that runs no more often than offers go stale leaves its
   * offers stale for part of every cycle, and their products priced without
   * them. Only logged: the fix is the source's frequency, or freshnessDays.
   */
  private async warnAboutSlowSources(): Promise<void> {
    const freshnessDays = this.offerFreshness.freshnessDays;
    const staleAfterMs = ms(`${freshnessDays} days`);
    const sources = await this.sourceRepo.find({ where: { schedulingEnabled: true } });
    for (const source of sources) {
      if (!source.frequency) continue;
      const frequencyMs = ms(source.frequency);
      if (!Number.isFinite(frequencyMs) || frequencyMs < staleAfterMs) continue;
      this.logger.warn('A scheduled source runs less often than its offers go stale', {
        source: source.name,
        frequency: source.frequency,
        freshnessDays,
        hint: 'Its offers stop setting their products\' prices between runs. Shorten the source\'s frequency, or raise offers.freshnessDays.',
      });
    }
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

  private async deleteStale(): Promise<
    Omit<StaleOfferSweepResult, 'contributorsRecomposed' | 'productsRepriced'>
  > {
    const cutoff = this.offerFreshness.deleteCutoff();
    const freshnessCutoff = this.offerFreshness.visibleCutoff();

    const keptForSilentSellers = await this.warnAboutSilentSellers(cutoff, freshnessCutoff);

    const stale = await this.offerRepo.findStaleForDeletion(
      cutoff,
      freshnessCutoff,
      STALE_OFFER_SWEEP_MAX_DELETIONS_PER_RUN,
    );

    if (stale.length === 0) {
      this.logger.debug('Stale offer sweep: nothing to delete', { cutoff });
      return { deleted: 0, modelsRecomputed: 0, keptForSilentSellers, cutoff, capped: false };
    }

    // Collected BEFORE the delete — the offers carry the only reference back to
    // their products, and after the delete there is nothing left to ask.
    const removedByModel = this.removedKeysByModel(stale);
    const affectedModelIds = [...removedByModel.keys()];

    const capped = stale.length === STALE_OFFER_SWEEP_MAX_DELETIONS_PER_RUN;

    // Dry run unless enabled. The sweep's premise is that imports ARE running —
    // an offer is only "gone" because a run that happened stopped confirming
    // it. The candidates are already limited to sellers something still
    // confirms; this switch is the kill switch on top of that.
    if (!this.offerFreshness.deletionEnabled) {
      this.logger.warn(
        'Stale offer sweep: deletion DISABLED — would have deleted offers',
        {
          wouldDelete: stale.length,
          cutoff,
          deleteAfterDays: this.offerFreshness.deleteAfterDays,
          affectedModels: affectedModelIds.length,
          capped,
          hint: 'offers.deletionEnabled is off in offers.json — the kill switch.',
        },
      );

      return { deleted: 0, modelsRecomputed: 0, keptForSilentSellers, cutoff, capped };
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
      keptForSilentSellers,
      cutoff,
      capped,
    };
  }

  /**
   * The offers past the delete cutoff that deletion leaves alone because
   * nothing of their seller was confirmed within freshnessDays — a broken or
   * paused source, or an environment that is not importing. One warning per
   * such seller; returns how many offers they hold.
   */
  private async warnAboutSilentSellers(
    deleteCutoff: Date,
    freshnessCutoff: Date,
  ): Promise<number> {
    const silent = await this.offerRepo.countStaleOfSilentSellers(
      deleteCutoff,
      freshnessCutoff,
    );
    for (const seller of silent) {
      this.logger.warn('Stale offer sweep: keeping a seller\'s stale offers — nothing of it was confirmed recently', {
        sellerId: seller.sellerId,
        seller: seller.sellerName,
        kept: seller.count,
        freshnessDays: this.offerFreshness.freshnessDays,
        hint: 'Its sources are not importing. Fix or re-enable them; the offers are deleted once the seller is confirmed again.',
      });
    }
    return sumBy(silent, (seller) => seller.count);
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
