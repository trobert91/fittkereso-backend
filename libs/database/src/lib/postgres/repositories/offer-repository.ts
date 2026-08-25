import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { Offer } from '../models/offer.entity';
import { ProductModel } from '../models/product-model.entity';
import { Seller } from '../models/seller.entity';
import { ProductSourceRecord } from '../models/product-source-record.entity';
import { OfferCondition } from '../types/offer-condition';
import { OfferAvailability } from '../types/offer-availability';
import { ProductSpecs } from '../../models/product-spec';
import { nameOf } from '@fittkereso-backend/utils';

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

  // Manual fetch-then-save (not repo.upsert()) because condition defaults
  // only on create, and lastSeenAt/active need business logic (always bumped
  // on every successful scrape sighting), not a blind column overwrite.
  // Mirrors ProductDuplicateRepository.upsertPair's manual-fetch style.
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
    offer.availability = availability ?? OfferAvailability.unknown;
    offer.url = url;
    offer.externalId = externalId;
    offer.lastSeenAt = new Date();
    offer.active = true;
    offer.specs = specs;

    try {
      return await this.repo.save(offer);
    } catch (error) {
      if (!existing && externalId && this.isConflict(error)) {
        // Concurrent worker inserted the same (seller, externalId) row
        // between the caller's preload and this save — re-fetch and update
        // it instead.
        const raceWinner = await this.repo.findOne({
          where: { seller: { id: seller.id }, externalId },
        });
        if (raceWinner) {
          raceWinner.price = price;
          raceWinner.priceWithoutDiscount = priceWithoutDiscount;
          raceWinner.currency = currency ?? 'HUF';
          raceWinner.availability = availability ?? OfferAvailability.unknown;
          raceWinner.url = url;
          raceWinner.sourceRecord = sourceRecord;
          raceWinner.lastSeenAt = new Date();
          raceWinner.active = true;
          raceWinner.specs = specs;
          return this.repo.save(raceWinner);
        }
      }
      throw error;
    }
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

  // Drives ProductModel.price/priceWithoutDiscount denormalization — the
  // cheapest active offer is what a price-sorted/filtered product listing
  // should reflect.
  async findCheapestActiveOffer(modelId: string): Promise<Offer | null> {
    return this.repo.findOne({
      where: { model: { id: modelId }, active: true },
      order: { price: 'ASC' },
    });
  }

  private isConflict(error: unknown): boolean {
    return (
      error instanceof Error && error.message.includes('duplicate key value')
    );
  }
}
