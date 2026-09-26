import { Injectable } from '@nestjs/common';
import {
  Offer,
  OfferAvailability,
  OfferCondition,
  OfferIdentityConflictError,
  OfferRepository,
  ProductModel,
  ProductSource,
  ProductSourceRecord,
  ProductSpecs,
  ScrapedOffer,
  Seller,
} from '@fittkereso-backend/database';
import {
  inspectGtin,
  nameOf,
  normalizeMpn,
  normalizeUrl,
  storedOfferExternalId,
} from '@fittkereso-backend/utils';
import { isEmpty, orderBy, uniq } from 'lodash';
import { OfferFreshnessService } from '@fittkereso-backend/dynamic-config';

const DEFAULT_CURRENCY = 'HUF';

/**
 * What a product must be loaded with before its offers are composed: every
 * record, each with its source and that source's seller.
 */
export const OFFER_COMPOSER_MODEL_RELATIONS: string[] = [
  nameOf<ProductModel>('sources'),
  `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}`,
  `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}.${nameOf<ProductSource>('seller')}`,
];

/** One source's say about one offer: its record, and that record's entry for it. */
export interface OfferCandidate {
  record: ProductSourceRecord;
  entry: ScrapedOffer;
}

export interface ComposeOffersParams {
  /** Loaded with OFFER_COMPOSER_MODEL_RELATIONS, under the caller's product lock. */
  model: ProductModel;
  seller: Seller;
  externalIds: string[];
  /** A source listed these offers just now: they are stamped as synced. */
  sighted: boolean;
  /** Whether a missing offer may be created (only an identifying listing may). */
  create: boolean;
}

export interface ComposedOffers {
  offers: Offer[];
  /** Offers that sit on another product: refused and left as they are. */
  conflicts: OfferIdentityConflictError[];
}

/** Every value an offer takes from its seller's records. */
interface ComposedFields {
  price: number;
  priceWithoutDiscount: number | null;
  currency: string;
  availability: OfferAvailability | null;
  url: string | null;
  gtin: string | null;
  mpn: string | null;
  locations: string[] | null;
  specs: ProductSpecs;
  /** The record that supplied the price. */
  sourceRecord: ProductSourceRecord;
}

/** When a record's source last listed it. */
function seenAt(record: ProductSourceRecord): Date {
  return record.lastSeenAt ?? record.lastUpdated;
}

/**
 * Writes a seller's offer from all of that seller's records that list it, so
 * which source imported last no longer decides what the offer says.
 *
 * Field by field, the highest-priority source that speaks for a field wins. A
 * source speaks for a field when its entry has the key: `null` is its "none"
 * and counts, an absent key is silence and leaves the field to the next source
 * (see ScrapedOffer). Only current records count — ones whose source listed
 * the item within the offer freshness window — so a source that dropped an
 * item stops overwriting the others.
 */
@Injectable()
export class OfferComposerService {
  constructor(
    private readonly offerRepo: OfferRepository,
    private readonly offerFreshness: OfferFreshnessService,
  ) {}

  public async compose(params: ComposeOffersParams): Promise<ComposedOffers> {
    const { model, seller, sighted, create } = params;
    const externalIds = uniq(params.externalIds);
    const result: ComposedOffers = { offers: [], conflicts: [] };
    if (isEmpty(externalIds)) return result;

    const cutoff = this.offerFreshness.visibleCutoff();
    const existing = new Map(
      (await this.offerRepo.findBySellerAndExternalIds(seller.id, externalIds)).map(
        (offer) => [offer.externalId, offer],
      ),
    );

    for (const externalId of externalIds) {
      const candidates = this.candidatesFor({ model, sellerId: seller.id, externalId, cutoff });
      if (isEmpty(candidates)) continue;
      try {
        const offer = await this.write({
          model,
          seller,
          externalId,
          existing: existing.get(externalId),
          fields: this.resolve(candidates),
          sighted,
          create,
        });
        if (offer) result.offers.push(offer);
      } catch (error: unknown) {
        if (!(error instanceof OfferIdentityConflictError)) throw error;
        result.conflicts.push(error);
      }
    }
    return result;
  }

  /**
   * An offer with no externalId (several offers on one page collided on it):
   * nothing can join another source to it, so it is this one entry's values.
   */
  public async writeUnkeyed(params: {
    existing?: Offer;
    model: ProductModel;
    seller: Seller;
    record: ProductSourceRecord;
    entry: ScrapedOffer;
  }): Promise<Offer> {
    const offer = params.existing ?? this.newOffer(params.model, params.seller);
    this.assign(offer, this.resolve([{ record: params.record, entry: params.entry }]), true);
    return this.offerRepo.save(offer);
  }

  /** The seller's current records on this product that list this offer. */
  public currentCarriers(params: {
    model: ProductModel;
    sellerId: string;
    externalId: string;
  }): ProductSourceRecord[] {
    return this.candidatesFor({
      ...params,
      cutoff: this.offerFreshness.visibleCutoff(),
    }).map((candidate) => candidate.record);
  }

  /**
   * The seller's current entries for one offer, highest priority first, then
   * the most recently seen.
   */
  private candidatesFor(params: {
    model: ProductModel;
    sellerId: string;
    externalId: string;
    cutoff: Date;
  }): OfferCandidate[] {
    const { model, sellerId, externalId, cutoff } = params;
    const candidates: OfferCandidate[] = [];
    for (const record of model.sources ?? []) {
      if (!record.source) continue;
      if (!record.source.seller) {
        throw new Error(
          `Record ${record.id} of product ${model.id} was loaded without its source's seller`,
        );
      }
      if (record.source.seller.id !== sellerId || seenAt(record) < cutoff) continue;
      const entry = (record.scrapedProduct?.offers ?? []).find(
        (candidate) => storedOfferExternalId(record, candidate) === externalId,
      );
      if (entry) candidates.push({ record, entry });
    }
    return orderBy(
      candidates,
      [
        (candidate) => candidate.record.source?.priority ?? 0,
        (candidate) => seenAt(candidate.record).getTime(),
      ],
      ['desc', 'desc'],
    );
  }

  private resolve(candidates: OfferCandidate[]): ComposedFields {
    const first = <K extends keyof ScrapedOffer>(field: K): OfferCandidate | undefined =>
      candidates.find((candidate) => candidate.entry[field] !== undefined);

    // Every entry has a price, so the highest-priority one supplies it.
    const priceFrom = candidates[0];
    const price = priceFrom.entry.price;
    const oldPrice = first('priceWithoutDiscount')?.entry.priceWithoutDiscount ?? null;
    const url = first('url')?.entry.url;
    const locations = first('locations')?.entry.locations;

    return {
      price,
      // An old price at or below the current one is no discount — Google's
      // `price` equals the current price on every row without a sale.
      priceWithoutDiscount: oldPrice !== null && oldPrice > price ? oldPrice : null,
      currency: first('currency')?.entry.currency ?? DEFAULT_CURRENCY,
      availability: first('availability')?.entry.availability ?? null,
      url: url ? normalizeUrl(url) : null,
      gtin: inspectGtin(first('gtin')?.entry.gtin).gtin ?? null,
      mpn: normalizeMpn(first('mpn')?.entry.mpn) ?? null,
      locations: isEmpty(locations) ? null : (locations ?? null),
      specs: this.resolveSpecs(candidates),
      sourceRecord: priceFrom.record,
    };
  }

  /** Key by key: the highest-priority entry that has a value for it. */
  private resolveSpecs(candidates: OfferCandidate[]): ProductSpecs {
    const specs: ProductSpecs = {};
    for (const { entry } of candidates) {
      for (const [key, value] of Object.entries(entry.specs ?? {})) {
        if (value !== undefined && specs[key] === undefined) specs[key] = value;
      }
    }
    return specs;
  }

  private async write(params: {
    model: ProductModel;
    seller: Seller;
    externalId: string;
    existing?: Offer;
    fields: ComposedFields;
    sighted: boolean;
    create: boolean;
  }): Promise<Offer | undefined> {
    const { model, seller, externalId, existing, fields, sighted, create } = params;
    if (existing) {
      this.assertSameProduct({ offer: existing, model, seller, externalId });
    } else if (!create) {
      return undefined;
    }

    const offer = existing ?? this.newOffer(model, seller, externalId);
    this.assign(offer, fields, sighted);
    try {
      return await this.offerRepo.save(offer);
    } catch (error: unknown) {
      if (existing || !this.isUniqueViolation(error)) throw error;
      // Another writer inserted this (seller, externalId) since it was looked
      // up — another product's import, under that product's lock.
      const [owner] = await this.offerRepo.findBySellerAndExternalIds(seller.id, [externalId]);
      if (!owner) throw error;
      this.assertSameProduct({ offer: owner, model, seller, externalId });
      this.assign(owner, fields, sighted);
      return this.offerRepo.save(owner);
    }
  }

  /**
   * An offer never moves between products here: two sources resolving
   * different products for one listing is an identity disagreement for a
   * person to settle (OfferIdentityConflictError).
   */
  private assertSameProduct(params: {
    offer: Offer;
    model: ProductModel;
    seller: Seller;
    externalId: string;
  }): void {
    const { offer, model, seller, externalId } = params;
    if (offer.model && offer.model.id !== model.id) {
      throw new OfferIdentityConflictError({
        externalId,
        sellerId: seller.id,
        offerId: offer.id,
        existingModelId: offer.model.id,
        incomingModelId: model.id,
      });
    }
  }

  private newOffer(model: ProductModel, seller: Seller, externalId?: string): Offer {
    const offer = new Offer();
    offer.model = model;
    offer.seller = seller;
    offer.externalId = externalId;
    offer.condition = OfferCondition.new;
    return offer;
  }

  /**
   * Every field is assigned, `null` included: TypeORM's save() skips undefined
   * properties, which is how a stale old price used to survive a sale ending.
   */
  private assign(offer: Offer, fields: ComposedFields, sighted: boolean): void {
    offer.price = fields.price;
    offer.priceWithoutDiscount = fields.priceWithoutDiscount;
    offer.currency = fields.currency;
    offer.availability = fields.availability;
    offer.url = fields.url;
    offer.gtin = fields.gtin;
    offer.mpn = fields.mpn;
    offer.locations = fields.locations;
    offer.specs = fields.specs;
    offer.sourceRecord = fields.sourceRecord;
    if (sighted) offer.lastSynced = new Date();
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && error.message.includes('duplicate key value');
  }
}
