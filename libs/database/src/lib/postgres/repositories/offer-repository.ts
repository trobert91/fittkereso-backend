import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { BasePostgresRepository } from './base-postgres-repository';
import { countByRelationIds } from './grouped-count';
import { Offer } from '../models/offer.entity';
import { ProductModel } from '../models/product-model.entity';
import { Seller } from '../models/seller.entity';
import { ProductSourceRecord } from '../models/product-source-record.entity';
import { OfferCondition } from '../types/offer-condition';
import { OfferAvailability } from '../types/offer-availability';
import { ProductSpecs } from '../../models/product-spec';
import { nameOf } from '@fittkereso-backend/utils';
import { OfferIdentityConflictError } from './offer-identity-conflict.error';

export interface UpsertOfferFromScrapeParams {
  existing?: Offer;
  model: ProductModel;
  seller: Seller;
  sourceRecord: ProductSourceRecord;
  price: number;
  /** Pre-discount price — only set when this offer is currently discounted. */
  priceWithoutDiscount?: number;
  currency?: string;
  availability?: OfferAvailability;
  url?: string;
  externalId?: string;
  /** Already normalized (normalizeGtin/normalizeMpn) — this layer stores what
   *  it is given. Absent is written as null, so a source that stops
   *  publishing one clears it rather than leaving a stale key to match on. */
  gtin?: string;
  mpn?: string;
  /** Store/warehouse names where this offer is physically available —
   *  always optional, absence is normal and must never block the upsert. */
  locations?: string[];
  /** Offer-level spec values (e.g. frameSize, color) — always optional,
   *  absence is normal and must never block the upsert. */
  specs?: ProductSpecs;
}

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

  // Manual fetch-then-save (not repo.upsert()) because condition defaults
  // only on create, and lastSynced/active need business logic (always bumped
  // on every successful scrape sighting), not a blind column overwrite.
  // `existing` is pre-resolved by the caller (OfferMatchingService, run
  // against a batch preload) rather than looked up here — see
  // ProductScrapeUpdaterService.createOrUpdateOffers.
  async upsertFromScrape(
    params: UpsertOfferFromScrapeParams,
  ): Promise<Offer> {
    const {
      existing,
      model,
      seller,
      sourceRecord,
      price,
      priceWithoutDiscount,
      currency,
      availability,
      url,
      externalId,
      gtin,
      mpn,
      locations,
      specs,
    } = params;

    const offer = existing ?? new Offer();
    offer.model = model;
    offer.seller = seller;
    offer.sourceRecord = sourceRecord;
    offer.condition = offer.condition ?? OfferCondition.new;
    offer.price = price;
    offer.priceWithoutDiscount = priceWithoutDiscount;
    offer.currency = currency ?? 'HUF';
    // `null`, not `unknown`, when the source reports nothing: asserting
    // `unknown` would make a feed that has no stock data at all look like one
    // whose stock data we failed to parse. See Offer.availability.
    offer.availability = availability ?? null;
    offer.url = url;
    offer.externalId = externalId;
    offer.gtin = gtin ?? null;
    offer.mpn = mpn ?? null;
    offer.locations = locations;
    offer.lastSynced = new Date();
    offer.active = true;
    offer.specs = specs;

    try {
      return await this.repo.save(offer);
    } catch (error) {
      if (!existing && externalId && this.isConflict(error)) {
        // CROSS-SOURCE ADOPTION — read this as the normal path, not as rare
        // concurrency handling.
        //
        // It was written for the latter: two workers inserting the same
        // (seller, externalId) row between one caller's preload and its save.
        // That still happens, but it is no longer the common case. Offers are
        // preloaded per SOURCE, so when a second source imports a listing the
        // first already owns, its preload cannot see that row — the insert
        // conflicts, and this branch is what makes the two sources converge on
        // one offer instead of failing. It runs every night.
        const owner = await this.repo.findOne({
          where: { seller: { id: seller.id }, externalId },
          relations: ['model'],
        });
        if (owner) {
          // The two sources disagree about WHICH PRODUCT this listing is.
          //
          // Assigning `model` here would silently move a listing between
          // products; leaving it unassigned (the original behaviour) silently
          // leaves it on the other source's product, with this model left
          // offer-less and therefore price-less and out of price-sorted search.
          // Both are silent, so neither is acceptable as a default: refuse the
          // write, keep the existing row exactly as it is, and make the
          // disagreement loud enough to be resolved by a person.
          if (owner.model && owner.model.id !== model.id) {
            throw new OfferIdentityConflictError({
              externalId,
              sellerId: seller.id,
              offerId: owner.id,
              existingModelId: owner.model.id,
              incomingModelId: model.id,
            });
          }

          owner.price = price;
          owner.priceWithoutDiscount = priceWithoutDiscount;
          owner.currency = currency ?? 'HUF';
          owner.availability = availability ?? null;
          owner.url = url;
          // Provenance follows whichever source stamped the offer last. On an
          // offer shared by two sources that means it alternates nightly —
          // correct for price and freshness, meaningless as attribution. Do not
          // read `sourceRecord` on a shared offer as "the source that owns it".
          owner.sourceRecord = sourceRecord;
          owner.gtin = gtin ?? null;
          owner.mpn = mpn ?? null;
          owner.locations = locations;
          owner.lastSynced = new Date();
          owner.active = true;
          owner.specs = specs;
          return this.repo.save(owner);
        }
      }
      throw error;
    }
  }

  /**
   * Refresh one offer from a list card — price, availability and the freshness
   * stamp, and nothing else.
   *
   * Deliberately NOT upsertFromScrape, which assigns `url`, `sourceRecord`,
   * `locations` and `specs` unconditionally. A ScrapedListProduct carries none
   * of those by design, so routing this path through it would blank an offer's
   * specs and locations on every nightly list pass. Nothing else is observable
   * from a list card, so nothing else may be written from one.
   *
   * `availability` is skipped when undefined rather than written as `unknown`:
   * a card that does not expose stock must leave whatever a detail scrape
   * established intact. A refresh may not degrade data it cannot observe.
   */
  async refreshFromListProduct(
    offerId: string,
    values: {
      price?: number;
      priceWithoutDiscount?: number;
      currency?: string;
      availability?: OfferAvailability;
    },
  ): Promise<void> {
    const update: QueryDeepPartialEntity<Offer> = { lastSynced: new Date() };

    if (values.price !== undefined) update.price = values.price;
    if (values.currency !== undefined) update.currency = values.currency;
    if (values.availability !== undefined) {
      update.availability = values.availability;
    }
    // Assigned even when undefined: an offer that has come OFF discount must
    // lose its pre-discount price, and absence is how a card says that.
    if (values.price !== undefined) {
      update.priceWithoutDiscount = values.priceWithoutDiscount;
    }

    await this.repo.update(offerId, update);
  }

  // Batch-preload every Offer this model has from a given source, spanning
  // all of that source's ProductSourceRecords (not just one) — a
  // multi-variant scrape can persist offers under several ProductSourceRecord
  // rows for the same source (one per variant URL), and two independently
  // enqueued tasks can each create their own record for overlapping variants.
  // Scoping by source rather than a single sourceRecord is what lets
  // OfferMatchingService find and update an offer regardless of which record
  // originally created it. See ProductScrapeUpdaterService.createOrUpdateOffers.
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
      relations: [nameOf<Offer>('model')],
      order: { lastSynced: 'ASC' },
      take: limit,
    });
  }

  private isConflict(error: unknown): boolean {
    return (
      error instanceof Error && error.message.includes('duplicate key value')
    );
  }
}
