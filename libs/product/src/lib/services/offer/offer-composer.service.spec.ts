import {
  Offer,
  OfferAvailability,
  OfferCondition,
  OfferIdentityConflictError,
  OfferRepository,
  ProductModel,
  ProductSourceRecord,
  ScrapedOffer,
  Seller,
} from '@fittkereso-backend/database';
import { OfferComposerService } from './offer-composer.service';
import { OfferFreshnessService } from '@fittkereso-backend/dynamic-config';

const NOW = new Date('2026-09-25T12:00:00Z');
const CUTOFF = new Date('2026-09-18T12:00:00Z');
const FRESH = new Date('2026-09-25T02:00:00Z');
const STALE = new Date('2026-09-10T02:00:00Z');

const SELLER = { id: 'speedbike' } as Seller;
const OTHER_SELLER = { id: 'ebikeshop' } as Seller;

const record = (params: {
  id: string;
  priority?: number;
  seller?: Seller | null;
  seenAt?: Date;
  offers: ScrapedOffer[];
  url?: string;
}): ProductSourceRecord =>
  ({
    id: params.id,
    url: params.url ?? `https://speedbike.hu/${params.id}`,
    source: {
      id: `source-${params.id}`,
      priority: params.priority ?? 10,
      seller: params.seller === null ? undefined : (params.seller ?? SELLER),
    },
    scrapedProduct: { offers: params.offers },
    lastSeenAt: params.seenAt ?? FRESH,
    lastUpdated: params.seenAt ?? FRESH,
  }) as ProductSourceRecord;

const entry = (overrides: Partial<ScrapedOffer> = {}): ScrapedOffer => ({
  price: 1499990,
  resolvedExternalId: 'HAIBIKE-451641xx-2021',
  ...overrides,
});

const productWith = (...records: ProductSourceRecord[]): ProductModel =>
  ({ id: 'model-1', sources: records }) as ProductModel;

describe('OfferComposerService', () => {
  let offerRepo: jest.Mocked<Pick<OfferRepository, 'findBySellerAndExternalIds' | 'save'>>;
  let composer: OfferComposerService;

  const compose = (model: ProductModel, overrides: { sighted?: boolean; create?: boolean } = {}) =>
    composer.compose({
      model,
      seller: SELLER,
      externalIds: ['HAIBIKE-451641xx-2021'],
      sighted: overrides.sighted ?? true,
      create: overrides.create ?? true,
    });

  const composedOffer = async (...records: ProductSourceRecord[]): Promise<Offer> => {
    const { offers } = await compose(productWith(...records));
    expect(offers).toHaveLength(1);
    return offers[0];
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    offerRepo = {
      findBySellerAndExternalIds: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(async (offer: Offer) => offer),
    };
    composer = new OfferComposerService(
      offerRepo as unknown as OfferRepository,
      { visibleCutoff: () => CUTOFF } as OfferFreshnessService,
    );
  });

  afterEach(() => jest.useRealTimers());

  describe('one source, as before', () => {
    it('creates a new offer defaulting condition to "new", sighted now', async () => {
      const offer = await composedOffer(record({ id: 'arukereso', offers: [entry()] }));

      expect(offer).toMatchObject({
        condition: OfferCondition.new,
        price: 1499990,
        externalId: 'HAIBIKE-451641xx-2021',
        lastSynced: NOW,
      });
      expect(offer.model).toEqual(expect.objectContaining({ id: 'model-1' }));
      expect(offer.seller).toBe(SELLER);
    });

    it('updates an existing offer in place without clobbering a non-default condition', async () => {
      const existing = Object.assign(new Offer(), {
        id: 'offer-1',
        externalId: 'HAIBIKE-451641xx-2021',
        condition: OfferCondition.refurbished,
        price: 150000,
        lastSynced: new Date('2026-09-01T00:00:00Z'),
        model: { id: 'model-1' },
      });
      offerRepo.findBySellerAndExternalIds.mockResolvedValue([existing]);

      const offer = await composedOffer(record({ id: 'arukereso', offers: [entry()] }));

      expect(offer).toBe(existing);
      expect(offer.condition).toBe(OfferCondition.refurbished);
      expect(offer.price).toBe(1499990);
      expect(offer.lastSynced).toEqual(NOW);
    });

    it('defaults the currency, and leaves availability null when no source reports one', async () => {
      const offer = await composedOffer(record({ id: 'arukereso', offers: [entry()] }));

      expect(offer.currency).toBe('HUF');
      // Null, NOT `unknown`: a source that publishes no stock data must not
      // look like one whose stock data we failed to parse.
      expect(offer.availability).toBeNull();
    });

    it('keeps a reported availability and locations', async () => {
      const offer = await composedOffer(
        record({
          id: 'ebikeshop',
          offers: [
            entry({
              availability: OfferAvailability.out_of_stock,
              locations: ['Törökbálinti raktár', 'Törökbálint'],
            }),
          ],
        }),
      );

      expect(offer.availability).toBe(OfferAvailability.out_of_stock);
      expect(offer.locations).toEqual(['Törökbálinti raktár', 'Törökbálint']);
    });

    it('normalizes the identifiers, dropping an invalid GTIN', async () => {
      const valid = await composedOffer(
        record({ id: 'a', offers: [entry({ gtin: '9008594503199', mpn: '1260-040108' })] }),
      );
      expect(valid.gtin).toBe('09008594503199');
      expect(valid.mpn).toBe('1260040108');

      const invalid = await composedOffer(record({ id: 'a', offers: [entry({ gtin: '5461000' })] }));
      expect(invalid.gtin).toBeNull();
    });

    // Identifiers are looked up across shops, so one a source has stopped
    // publishing must not linger on the offer and keep matching.
    it('clears what an existing offer had when no source says it any more', async () => {
      const existing = Object.assign(new Offer(), {
        id: 'offer-1',
        externalId: 'HAIBIKE-451641xx-2021',
        condition: OfferCondition.new,
        gtin: '09008594503199',
        mpn: '1260040108',
        priceWithoutDiscount: 2269000,
        locations: ['Törökbálint'],
        model: { id: 'model-1' },
      });
      offerRepo.findBySellerAndExternalIds.mockResolvedValue([existing]);

      const offer = await composedOffer(record({ id: 'a', offers: [entry()] }));

      expect(offer.gtin).toBeNull();
      expect(offer.mpn).toBeNull();
      expect(offer.priceWithoutDiscount).toBeNull();
      expect(offer.locations).toBeNull();
    });

    it('keeps an old price only when it is above the price', async () => {
      const above = await composedOffer(
        record({ id: 'g', offers: [entry({ priceWithoutDiscount: 2269000 })] }),
      );
      expect(above.priceWithoutDiscount).toBe(2269000);

      // Google's `price` equals the current price on every row without a sale.
      const equal = await composedOffer(
        record({ id: 'g', offers: [entry({ priceWithoutDiscount: 1499990 })] }),
      );
      expect(equal.priceWithoutDiscount).toBeNull();
    });
  });

  describe('several sources of the seller', () => {
    it('takes each field from the highest-priority source that speaks for it', async () => {
      const arukereso = record({
        id: 'arukereso',
        priority: 60,
        offers: [entry({ price: 1499990, availability: OfferAvailability.in_stock })],
      });
      const google = record({
        id: 'google',
        priority: 40,
        offers: [
          entry({
            price: 1599990,
            priceWithoutDiscount: 2269000,
            availability: OfferAvailability.out_of_stock,
          }),
        ],
      });

      const offer = await composedOffer(google, arukereso);

      expect(offer.price).toBe(1499990);
      expect(offer.availability).toBe(OfferAvailability.in_stock);
      // The Árukereső feed does not map an old price, so Google decides it.
      expect(offer.priceWithoutDiscount).toBe(2269000);
      // The record that supplied the price.
      expect(offer.sourceRecord).toBe(arukereso);
    });

    it('lets a higher source\'s null ("none") win over a lower source\'s value', async () => {
      const offer = await composedOffer(
        record({ id: 'high', priority: 60, offers: [entry({ priceWithoutDiscount: null })] }),
        record({ id: 'low', priority: 40, offers: [entry({ priceWithoutDiscount: 2269000 })] }),
      );

      expect(offer.priceWithoutDiscount).toBeNull();
    });

    it('ignores a source that no longer lists the item', async () => {
      const stale = record({ id: 'arukereso', priority: 60, seenAt: STALE, offers: [entry({ price: 1 })] });
      const google = record({ id: 'google', priority: 40, offers: [entry({ price: 1599990 })] });

      const offer = await composedOffer(stale, google);

      expect(offer.price).toBe(1599990);
      expect(offer.sourceRecord).toBe(google);
    });

    it('composes the offer specs key by key', async () => {
      const offer = await composedOffer(
        record({ id: 'high', priority: 60, offers: [entry({ specs: { frameSize: 48 } })] }),
        record({
          id: 'low',
          priority: 40,
          offers: [entry({ specs: { frameSize: 52, frameSizeLabel: 'L' } })],
        }),
      );

      expect(offer.specs).toEqual({ frameSize: 48, frameSizeLabel: 'L' });
    });

    it('prefers the most recently seen record of equal priority', async () => {
      const older = record({ id: 'older', seenAt: new Date('2026-09-20'), offers: [entry({ price: 1 })] });
      const newer = record({ id: 'newer', seenAt: FRESH, offers: [entry({ price: 2 })] });

      expect((await composedOffer(older, newer)).price).toBe(2);
    });

    it('ignores another seller\'s records', async () => {
      const offer = await composedOffer(
        record({ id: 'other', priority: 99, seller: OTHER_SELLER, offers: [entry({ price: 1 })] }),
        record({ id: 'mine', priority: 10, offers: [entry({ price: 1499990 })] }),
      );

      expect(offer.price).toBe(1499990);
    });

    it('refuses a record whose source was loaded without its seller', async () => {
      await expect(
        compose(productWith(record({ id: 'bare', seller: null, offers: [entry()] }))),
      ).rejects.toThrow(/without its source's seller/);
    });
  });

  describe('which entries join an offer', () => {
    it('joins an entry stored before resolvedExternalId by the id derived then', async () => {
      const legacy = record({
        id: 'a',
        offers: [{ price: 1499990, externalId: ' HAIBIKE-451641xx-2021 ' }],
      });

      expect((await composedOffer(legacy)).price).toBe(1499990);
    });

    it('never joins an entry whose id collided on its page', async () => {
      const page = record({
        id: 'a',
        offers: [{ price: 1, externalId: 'HAIBIKE-451641xx-2021', resolvedExternalId: null }],
      });

      const { offers } = await compose(productWith(page));

      expect(offers).toEqual([]);
    });

    it('composes nothing for an id no current record lists', async () => {
      const { offers } = await compose(
        productWith(record({ id: 'stale', seenAt: STALE, offers: [entry()] })),
      );

      expect(offers).toEqual([]);
      expect(offerRepo.save).not.toHaveBeenCalled();
    });

    it('lists the current records carrying an offer', () => {
      const current = record({ id: 'current', offers: [entry()] });
      const stale = record({ id: 'stale', seenAt: STALE, offers: [entry()] });

      expect(
        composer.currentCarriers({
          model: productWith(current, stale),
          sellerId: SELLER.id,
          externalId: 'HAIBIKE-451641xx-2021',
        }),
      ).toEqual([current]);
    });
  });

  describe('writing', () => {
    it('does not create a missing offer unless asked to', async () => {
      const { offers } = await compose(productWith(record({ id: 'a', offers: [entry()] })), {
        create: false,
      });

      expect(offers).toEqual([]);
      expect(offerRepo.save).not.toHaveBeenCalled();
    });

    it('leaves lastSynced alone when nothing was sighted', async () => {
      const lastSynced = new Date('2026-09-20');
      offerRepo.findBySellerAndExternalIds.mockResolvedValue([
        Object.assign(new Offer(), {
          id: 'offer-1',
          externalId: 'HAIBIKE-451641xx-2021',
          lastSynced,
          model: { id: 'model-1' },
        }),
      ]);

      const { offers } = await compose(productWith(record({ id: 'a', offers: [entry()] })), {
        sighted: false,
      });

      expect(offers[0].lastSynced).toBe(lastSynced);
    });

    // Moving the offer would silently relocate a listing; leaving the incoming
    // product without it would strand it priceless. Refused, and reported.
    it('refuses an offer that sits on another product, leaving it as it was', async () => {
      const owned = Object.assign(new Offer(), {
        id: 'offer-owned',
        externalId: 'HAIBIKE-451641xx-2021',
        price: 111,
        model: { id: 'someone-elses-model' },
      });
      offerRepo.findBySellerAndExternalIds.mockResolvedValue([owned]);

      const { offers, conflicts } = await compose(productWith(record({ id: 'a', offers: [entry()] })));

      expect(offers).toEqual([]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toBeInstanceOf(OfferIdentityConflictError);
      expect(conflicts[0].details).toEqual({
        externalId: 'HAIBIKE-451641xx-2021',
        sellerId: 'speedbike',
        offerId: 'offer-owned',
        existingModelId: 'someone-elses-model',
        incomingModelId: 'model-1',
      });
      expect(offerRepo.save).not.toHaveBeenCalled();
      expect(owned.price).toBe(111);
    });

    it('adopts the row a concurrent import inserted first, for the same product', async () => {
      const owner = Object.assign(new Offer(), {
        id: 'offer-owned',
        externalId: 'HAIBIKE-451641xx-2021',
        condition: OfferCondition.new,
        model: { id: 'model-1' },
      });
      offerRepo.findBySellerAndExternalIds
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([owner]);
      offerRepo.save.mockRejectedValueOnce(
        new Error('duplicate key value violates unique constraint "UQ_offer_seller_externalId"'),
      );

      const offer = await composedOffer(record({ id: 'a', offers: [entry()] }));

      expect(offer).toBe(owner);
      expect(owner.price).toBe(1499990);
    });

    it('reports a concurrent insert for another product as a conflict', async () => {
      offerRepo.findBySellerAndExternalIds
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          Object.assign(new Offer(), {
            id: 'offer-owned',
            externalId: 'HAIBIKE-451641xx-2021',
            model: { id: 'someone-elses-model' },
          }),
        ]);
      offerRepo.save.mockRejectedValueOnce(
        new Error('duplicate key value violates unique constraint "UQ_offer_seller_externalId"'),
      );

      const { conflicts } = await compose(productWith(record({ id: 'a', offers: [entry()] })));

      expect(conflicts).toHaveLength(1);
    });

    it('rethrows any other failure', async () => {
      offerRepo.save.mockRejectedValueOnce(new Error('connection reset'));

      await expect(compose(productWith(record({ id: 'a', offers: [entry()] })))).rejects.toThrow(
        'connection reset',
      );
    });

    it('writes an offer without an externalId from its one entry', async () => {
      const page = record({ id: 'a', offers: [] });

      const offer = await composer.writeUnkeyed({
        model: productWith(page),
        seller: SELLER,
        record: page,
        entry: { price: 999, resolvedExternalId: null, priceWithoutDiscount: 1200 },
      });

      expect(offer).toMatchObject({
        price: 999,
        priceWithoutDiscount: 1200,
        condition: OfferCondition.new,
        externalId: undefined,
        sourceRecord: page,
        lastSynced: NOW,
      });
    });
  });
});
