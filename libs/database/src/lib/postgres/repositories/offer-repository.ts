import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { countByRelationIds } from './grouped-count';
import { Offer } from '../models/offer.entity';
import { nameOf } from '@fittkereso-backend/utils';

@Injectable()
export class OfferRepository extends BasePostgresRepository<Offer> {
  constructor(
    @InjectRepository(Offer, 'postgres')
    repository: Repository<Offer>,
  ) {
    super(repository, Offer);
  }

  /** How many offers sit on each of these products, in one query. */
  async countByModelIds(modelIds: string[]): Promise<Map<string, number>> {
    return countByRelationIds(this.repo, nameOf<Offer>('model'), modelIds);
  }

  // Batch-preload every Offer this model has from a given source, spanning
  // all of that source's ProductSourceRecords (not just one) — a
  // multi-variant scrape can persist offers under several ProductSourceRecord
  // rows for the same source (one per variant URL), and two independently
  // enqueued tasks can each create their own record for overlapping variants.
  // Scoping by source rather than a single sourceRecord is what lets
  // OfferMatchingService find and update an offer regardless of which record
  // originally created it. Only offers without an externalId are matched this
  // way now (ProductScrapeUpdaterService.writeUnkeyedOffers); the rest are
  // keyed by (seller, externalId) and composed (OfferComposerService).
  async findAllByModelAndSource(
    modelId: string,
    sourceId: string,
  ): Promise<Offer[]> {
    return this.repo.find({
      where: { model: { id: modelId }, sourceRecord: { source: { id: sourceId } } },
      relations: [nameOf<Offer>('seller'), nameOf<Offer>('sourceRecord')],
    });
  }

  // Path 3 identity-resolution lookup (batch — tries every externalId
  // gathered by the current scrape, e.g. every variant's own sku when a
  // multi-variant scrape folds several offers together before identity
  // resolution runs). Returns the first Offer matching any of them.
  // `modelRelations` are relation names as returned by
  // ProductScrapeUpdaterService.getProductRelations() — i.e. relations of
  // ProductModel itself (e.g. "productCategory"), not of Offer — so they
  // must be prefixed with the `model` relation path here rather than
  // spread as siblings of it.
  async findFirstBySellerAndExternalIdsWithModelRelations(
    sellerId: string,
    externalIds: string[],
    modelRelations: string[],
  ): Promise<Offer | null> {
    if (externalIds.length === 0) return null;
    return this.repo.findOne({
      where: { seller: { id: sellerId }, externalId: In(externalIds) },
      relations: [
        nameOf<Offer>('model'),
        nameOf<Offer>('sourceRecord'),
        ...modelRelations.map((r) => `${nameOf<Offer>('model')}.${r}`),
      ],
    });
  }

  /**
   * A seller's offers under these externalIds, with the product each sits on:
   * what OfferComposerService writes to, and refuses to move.
   */
  async findBySellerAndExternalIds(
    sellerId: string,
    externalIds: string[],
  ): Promise<Offer[]> {
    if (externalIds.length === 0) return [];
    return this.repo.find({
      where: { seller: { id: sellerId }, externalId: In(externalIds) },
      relations: { model: true },
    });
  }

  /**
   * What a feed run needs to refresh a seller's offers in place: which of
   * these externalIds already have an offer, on which product, and when each
   * was last confirmed.
   */
  async findSyncStates(
    sellerId: string,
    externalIds: string[],
  ): Promise<
    { id: string; externalId: string; modelId: string; lastSynced: Date | null }[]
  > {
    if (externalIds.length === 0) return [];
    const offers = await this.repo.find({
      where: { seller: { id: sellerId }, externalId: In(externalIds) },
      relations: { model: true },
      select: { id: true, externalId: true, lastSynced: true, model: { id: true } },
    });
    return offers.map((offer) => ({
      id: offer.id,
      externalId: offer.externalId as string,
      modelId: offer.model.id,
      lastSynced: offer.lastSynced ?? null,
    }));
  }

  /**
   * A seller's offers on products of these categories, with each one's key and
   * product: what a complete run of a source listing the whole catalog weighs
   * against the rows it saw.
   */
  async findSellerOffersInCategories(
    sellerId: string,
    categorySlugs: string[],
  ): Promise<{ id: string; externalId: string | null; modelId: string }[]> {
    if (categorySlugs.length === 0) return [];
    const offers = await this.repo.find({
      where: {
        seller: { id: sellerId },
        model: { productCategory: { slug: In(categorySlugs) } },
      },
      relations: { model: { productCategory: true } },
      select: { id: true, externalId: true, model: { id: true, productCategory: { id: true } } },
    });
    return offers.map((offer) => ({
      id: offer.id,
      externalId: offer.externalId ?? null,
      modelId: offer.model.id,
    }));
  }

  /** Confirms these offers as seen now: what an unchanged feed row amounts to. */
  async stampSynced(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.repo.update(
      { id: In(ids) },
      { lastSynced: () => 'NOW()', active: true },
    );
  }

  /**
   * Which products have an offer carrying one of these GTINs, at any seller.
   *
   * Across sellers on purpose: a GTIN names one sellable item everywhere, so
   * this is how one shop's listing finds the product another shop's listing
   * already created. Pass normalized values (normalizeGtin).
   */
  async findModelIdsByGtins(
    gtins: string[],
  ): Promise<{ modelId: string; gtin: string }[]> {
    if (gtins.length === 0) return [];
    const offers = await this.repo.find({
      where: { gtin: In(gtins) },
      relations: { model: true },
      select: { id: true, gtin: true, model: { id: true } },
    });
    return offers.flatMap((offer) =>
      offer.gtin ? [{ modelId: offer.model.id, gtin: offer.gtin }] : [],
    );
  }

  /**
   * Which of this brand's products have an offer carrying one of these MPNs.
   *
   * Brand-scoped because an article number is only unique within its
   * manufacturer's own numbering. Pass normalized values (normalizeMpn).
   */
  async findModelIdsByMpns(
    brandId: string,
    mpns: string[],
  ): Promise<{ modelId: string; mpn: string }[]> {
    if (mpns.length === 0) return [];
    const offers = await this.repo.find({
      where: { mpn: In(mpns), model: { brand: { id: brandId } } },
      relations: { model: true },
      select: { id: true, mpn: true, model: { id: true } },
    });
    return offers.flatMap((offer) =>
      offer.mpn ? [{ modelId: offer.model.id, mpn: offer.mpn }] : [],
    );
  }

  // Drives ProductModel.price/priceWithoutDiscount denormalization — the
  // cheapest offer is what a price-sorted/filtered product listing should
  // reflect.
  //
  // `freshnessCutoff` is required, not optional: ProductModel.price is already
  // read by the public listing, sort and filter paths, so a stale offer left in
  // scope keeps setting a product's headline price after the listing is gone.
  // Callers pass OfferFreshnessService.visibleCutoff().
  //
  // Note this filters on lastSynced, NOT `active` — nothing in production ever
  // sets active to false, so an `active: true` predicate matches everything.
  async findCheapestFreshOffer(
    modelId: string,
    freshnessCutoff: Date,
  ): Promise<Offer | null> {
    return this.repo.findOne({
      where: {
        model: { id: modelId },
        lastSynced: MoreThanOrEqual(freshnessCutoff),
      },
      order: { price: 'ASC' },
    });
  }

  /**
   * This model's publicly visible offers — the ones a product page should show.
   * Uses the (model, lastSynced) index.
   */
  async findFreshByModel(
    modelId: string,
    freshnessCutoff: Date,
  ): Promise<Offer[]> {
    return this.repo.find({
      where: {
        model: { id: modelId },
        lastSynced: MoreThanOrEqual(freshnessCutoff),
      },
      relations: [nameOf<Offer>('seller')],
      order: { price: 'ASC' },
    });
  }

  /**
   * Offers nothing has confirmed since `deleteCutoff`, oldest first.
   *
   * `lastSynced IS NULL` rows are excluded by the comparison itself, which is
   * deliberate: those predate the freshness column and have never been stamped,
   * so they are hidden from the site but must never be swept — there is no
   * evidence about them either way.
   */
  async findStaleForDeletion(
    deleteCutoff: Date,
    limit: number,
  ): Promise<Offer[]> {
    return this.repo.find({
      where: { lastSynced: LessThan(deleteCutoff) },
      relations: [nameOf<Offer>('model'), nameOf<Offer>('seller')],
      order: { lastSynced: 'ASC' },
      take: limit,
    });
  }
}
