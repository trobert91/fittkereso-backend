import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { Offer } from '../models/offer.entity';
import { ProductModel } from '../models/product-model.entity';
import { Seller } from '../models/seller.entity';
import { ProductSource } from '../models/product-source.entity';
import { OfferCondition } from '../types/offer-condition';
import { OfferAvailability } from '../types/offer-availability';

export interface UpsertOfferFromScrapeParams {
  model: ProductModel;
  seller: Seller;
  source: ProductSource;
  price: number;
  currency?: string;
  availability?: OfferAvailability;
  url?: string;
  sourceListingId?: string;
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
    const { model, seller, source, price, currency, availability, url, sourceListingId } =
      params;

    const existing = sourceListingId
      ? await this.repo.findOne({
          where: { seller: { id: seller.id }, sourceListingId },
        })
      : undefined;

    const offer = existing ?? new Offer();
    offer.model = model;
    offer.seller = seller;
    offer.source = source;
    offer.condition = offer.condition ?? OfferCondition.new;
    offer.price = price;
    offer.currency = currency ?? 'HUF';
    offer.availability = availability ?? OfferAvailability.unknown;
    offer.url = url;
    offer.sourceListingId = sourceListingId;
    offer.lastSeenAt = new Date();
    offer.active = true;

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
          raceWinner.currency = currency ?? 'HUF';
          raceWinner.availability = availability ?? OfferAvailability.unknown;
          raceWinner.url = url;
          raceWinner.lastSeenAt = new Date();
          raceWinner.active = true;
          return this.repo.save(raceWinner);
        }
      }
      throw error;
    }
  }

  private isConflict(error: unknown): boolean {
    return (
      error instanceof Error && error.message.includes('duplicate key value')
    );
  }
}
