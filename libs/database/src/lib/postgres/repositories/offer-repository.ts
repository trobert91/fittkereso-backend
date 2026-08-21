import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { Offer } from '../models/offer.entity';
import { ProductModel } from '../models/product-model.entity';
import { Seller } from '../models/seller.entity';
import { ProductSourceRecord } from '../models/product-source-record.entity';
import { OfferCondition } from '../types/offer-condition';
import { OfferAvailability } from '../types/offer-availability';
import { ProductSpecs } from '../../models/product-spec';

export interface UpsertOfferFromScrapeParams {
  model: ProductModel;
  seller: Seller;
  sourceRecord: ProductSourceRecord;
  price: number;
  /** Pre-discount price — only set when this offer is currently discounted. */
  priceWithoutDiscount?: number;
  currency?: string;
  availability?: OfferAvailability;
  url?: string;
  sourceListingId?: string;
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
  async upsertFromScrape(
    params: UpsertOfferFromScrapeParams,
  ): Promise<Offer> {
    const {
      model,
      seller,
      sourceRecord,
      price,
      priceWithoutDiscount,
      currency,
      availability,
      url,
      sourceListingId,
      specs,
    } = params;

    const existing = sourceListingId
      ? await this.repo.findOne({
          where: { seller: { id: seller.id }, sourceListingId },
        })
      : undefined;

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
    offer.sourceListingId = sourceListingId;
    offer.lastSeenAt = new Date();
    offer.active = true;
    offer.specs = specs;

    try {
      return await this.repo.save(offer);
    } catch (error) {
      if (!existing && sourceListingId && this.isConflict(error)) {
        // Concurrent worker inserted the same [seller, sourceListingId] row
        // between our findOne and save — re-fetch and update it instead.
        const raceWinner = await this.repo.findOne({
          where: { seller: { id: seller.id }, sourceListingId },
        });
        if (raceWinner) {
          raceWinner.price = price;
          raceWinner.priceWithoutDiscount = priceWithoutDiscount;
          raceWinner.currency = currency ?? 'HUF';
          raceWinner.availability = availability ?? OfferAvailability.unknown;
          raceWinner.url = url;
          raceWinner.lastSeenAt = new Date();
          raceWinner.active = true;
          raceWinner.specs = specs;
          return this.repo.save(raceWinner);
        }
      }
      throw error;
    }
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
