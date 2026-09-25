import { Injectable } from '@nestjs/common';
import {
  AdvisoryLockService,
  OfferRepository,
  ProductModel,
  ProductModelRepository,
  ProductSource,
  productLock,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { nameOf } from '@fittkereso-backend/utils';
import { compact, groupBy, isEmpty } from 'lodash';
import { OfferFreshnessService } from './offer-freshness.service';
import { OFFER_COMPOSER_MODEL_RELATIONS } from './offer-composer.service';
import { ContributorDetachService } from './contributor-detach.service';
import { ProductMergeService } from '../merge/product-merge.service';

/**
 * The largest share of a seller's offers (in the run's categories) one
 * complete run may remove. Above it the run removes nothing: a feed that
 * suddenly lacks this much is far likelier truncated than a shop clearing out
 * its catalog. Raise it by hand for a real clear-out.
 */
export const MAX_COMPLETE_RUN_REMOVAL_SHARE = 0.1;

/** Why a complete source's run removed nothing, when it would have. */
export type CompleteRunRemovalSkip = 'disabled' | 'share_exceeded';

export interface CompleteRunRemoval {
  removed: number;
  skipped?: CompleteRunRemovalSkip;
  /** What the run would have removed, when it was skipped. */
  wouldRemove?: number;
}

/**
 * Removes the offers a complete run of a source did not see: one that lists
 * the shop's whole catalog (ProductSource.hasAllProducts), so an item missing
 * from it is gone from the shop — even while another source of the seller
 * still lists it, since that one may lag behind.
 *
 * The caller decides the run was complete (uncapped, unfiltered, every enabled
 * category, nothing failed). This removes, per product under its lock, then
 * detaches the contributing records that joined only those offers, so their
 * sources cannot bring them back, and recomputes the product's price.
 */
@Injectable()
export class CompleteSourceRemovalService {
  private readonly logger = new CustomLogger(CompleteSourceRemovalService.name);

  constructor(
    private readonly offerRepo: OfferRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly offerFreshness: OfferFreshnessService,
    private readonly contributorDetach: ContributorDetachService,
    private readonly mergeService: ProductMergeService,
    private readonly locks: AdvisoryLockService,
  ) {}

  /**
   * `source` with its seller loaded; `seenExternalIds` the offer keys of every
   * row the run found eligible; `categorySlugs` the source's enabled
   * categories, which the run covered.
   */
  public async removeUnseen(params: {
    source: ProductSource;
    seenExternalIds: Set<string>;
    categorySlugs: string[];
  }): Promise<CompleteRunRemoval> {
    const { source, seenExternalIds, categorySlugs } = params;
    const offers = await this.offerRepo.findSellerOffersInCategories(
      source.seller.id,
      categorySlugs,
    );
    // An offer without a key (ids collided on its page) is no row of a feed.
    const unseen = offers.filter(
      (offer) => offer.externalId && !seenExternalIds.has(offer.externalId),
    );
    if (isEmpty(unseen)) return { removed: 0 };

    if (!this.offerFreshness.completeSourceRemovalEnabled) {
      this.logger.warn('Complete-source removal is disabled — the unseen offers age out instead', {
        source: source.name,
        wouldRemove: unseen.length,
      });
      return { removed: 0, skipped: 'disabled', wouldRemove: unseen.length };
    }
    if (unseen.length > offers.length * MAX_COMPLETE_RUN_REMOVAL_SHARE) {
      this.logger.warn(
        'A complete run lacks too many of the seller\'s offers to be trusted — removing none. Is the feed truncated?',
        {
          source: source.name,
          wouldRemove: unseen.length,
          offersInCategories: offers.length,
          maxShare: MAX_COMPLETE_RUN_REMOVAL_SHARE,
        },
      );
      return { removed: 0, skipped: 'share_exceeded', wouldRemove: unseen.length };
    }

    let removed = 0;
    for (const [modelId, modelOffers] of Object.entries(
      groupBy(unseen, (offer) => offer.modelId),
    )) {
      try {
        removed += await this.locks.withLocks([productLock(modelId)], () =>
          this.removeFromProduct({
            source,
            modelId,
            externalIds: compact(modelOffers.map((offer) => offer.externalId)),
          }),
        );
      } catch (error) {
        // The rest of the products are independent; the next run retries this one.
        this.logger.error('Removing unseen offers from a product failed', error, {
          source: source.name,
          productId: modelId,
        });
      }
    }
    this.logger.log('Complete run removed the offers it did not see', {
      source: source.name,
      removed,
    });
    return { removed };
  }

  /** Under the product's lock, on offers read again under it. */
  private async removeFromProduct(params: {
    source: ProductSource;
    modelId: string;
    externalIds: string[];
  }): Promise<number> {
    const { source, modelId, externalIds } = params;
    const model = await this.productRepo.findOne({
      where: { id: modelId },
      relations: [...OFFER_COMPOSER_MODEL_RELATIONS, nameOf<ProductModel>('productCategory')],
    });
    if (!model) return 0;

    // An import may have moved one to another product since they were listed.
    const offers = (
      await this.offerRepo.findBySellerAndExternalIds(source.seller.id, externalIds)
    ).filter((offer) => offer.model?.id === modelId);
    if (isEmpty(offers)) return 0;

    await this.offerRepo.deleteByIds(offers.map((offer) => offer.id));
    await this.contributorDetach.detach({
      model,
      sellerId: source.seller.id,
      externalIds: compact(offers.map((offer) => offer.externalId)),
    });
    await this.mergeService.recomputePrice(model);
    await this.productRepo.save(model);
    return offers.length;
  }
}
