import { OfferAvailability, type ScrapedOffer } from '@fittkereso-backend/database';
import {
  DEFAULT_LIST_REFRESH_REQUIRED_FIELDS,
  ListProductRefreshService,
} from './list-product-refresh.service';

const SELLER = { id: 'seller-1' };
const SOURCE = { id: 'source-1', name: 'speedbike', seller: SELLER } as never;

/** A card carrying everything the default minimum set asks for. */
const completeItem = () => ({
  url: 'https://speedbike.hu/termek/macina',
  externalId: 'SKU-1',
  price: 1_339_990,
  currency: 'HUF',
  availability: OfferAvailability.in_stock,
});

describe('ListProductRefreshService', () => {
  let service: ListProductRefreshService;
  let sourceRecordRepo: { findBySourceAndUrl: jest.Mock; save: jest.Mock };
  let productRepo: { findOne: jest.Mock; save: jest.Mock };
  let mergeService: { recomputePrice: jest.Mock };
  let offerComposer: { compose: jest.Mock };
  let locks: { withLocks: jest.Mock };
  let dynamicConfig: { import?: { listRefreshRequiredFields?: string[] } };

  /** This source's record of the page, on product model-1. */
  const givenRecord = (offers: ScrapedOffer[], overrides: Record<string, unknown> = {}) => {
    const record = {
      id: 'record-1',
      url: 'https://speedbike.hu/termek/macina',
      model: { id: 'model-1' },
      source: { id: 'source-1', seller: SELLER },
      scrapedProduct: { offers },
      lastUpdated: new Date('2026-09-01'),
      lastSeenAt: undefined as Date | undefined,
      ...overrides,
    };
    sourceRecordRepo.findBySourceAndUrl.mockResolvedValue(record);
    productRepo.findOne.mockResolvedValue({ id: 'model-1', sources: [record] });
    return record;
  };
  const savedEntries = (): ScrapedOffer[] =>
    sourceRecordRepo.save.mock.calls[0][0].scrapedProduct.offers;

  beforeEach(() => {
    sourceRecordRepo = { findBySourceAndUrl: jest.fn(), save: jest.fn() };
    productRepo = { findOne: jest.fn(), save: jest.fn() };
    mergeService = { recomputePrice: jest.fn() };
    offerComposer = {
      compose: jest.fn().mockResolvedValue({ offers: [{ id: 'offer-1' }], conflicts: [] }),
    };
    locks = { withLocks: jest.fn(async (_keys: unknown, work: () => Promise<unknown>) => work()) };
    dynamicConfig = {};

    service = new ListProductRefreshService(
      sourceRecordRepo as never,
      productRepo as never,
      mergeService as never,
      offerComposer as never,
      locks as never,
      dynamicConfig as never,
    );
  });

  describe('requiredFields', () => {
    it('defaults to url, price and availability', () => {
      expect(service.requiredFields).toEqual(
        DEFAULT_LIST_REFRESH_REQUIRED_FIELDS,
      );
    });

    // The set is global config rather than a constant precisely so this
    // trade-off can be made per estate without a deploy — ebikeshop's cards
    // carry prices but no stock, so leaving `availability` in the set means
    // every one of its items still pays for a detail fetch.
    it('honours a configured override', () => {
      dynamicConfig.import = { listRefreshRequiredFields: ['url', 'price'] };

      expect(service.requiredFields).toEqual(['url', 'price']);
    });
  });

  describe('satisfiesMinimumSet', () => {
    it('accepts a card carrying every required field', () => {
      expect(service.satisfiesMinimumSet(completeItem() as never)).toBe(true);
    });

    it('rejects a card missing availability under the default set', () => {
      const item = { ...completeItem(), availability: undefined };

      expect(service.satisfiesMinimumSet(item as never)).toBe(false);
    });

    it('accepts that same card once availability is dropped from the set', () => {
      dynamicConfig.import = { listRefreshRequiredFields: ['url', 'price'] };
      const item = { ...completeItem(), availability: undefined };

      expect(service.satisfiesMinimumSet(item as never)).toBe(true);
    });

    it('treats an empty string as missing', () => {
      const item = { ...completeItem(), externalId: '' };
      dynamicConfig.import = { listRefreshRequiredFields: ['externalId'] };

      expect(service.satisfiesMinimumSet(item as never)).toBe(false);
    });

    it('treats price 0 as present', () => {
      // 0 is falsy but a real value — a free item is not a missing price.
      const item = { ...completeItem(), price: 0 };

      expect(service.satisfiesMinimumSet(item as never)).toBe(true);
    });
  });

  describe('tryRefresh', () => {
    it('reports unknown and writes nothing when this source has no record', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue(null);

      await expect(
        service.tryRefresh(SOURCE, completeItem() as never),
      ).resolves.toBe('unknown');
      expect(offerComposer.compose).not.toHaveBeenCalled();
    });

    it('reports incomplete and writes nothing when the card is too thin', async () => {
      givenRecord([{ price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1' }]);

      const item = { ...completeItem(), availability: undefined };

      await expect(service.tryRefresh(SOURCE, item as never)).resolves.toBe(
        'incomplete',
      );
      expect(sourceRecordRepo.save).not.toHaveBeenCalled();
      expect(offerComposer.compose).not.toHaveBeenCalled();
    });

    it('writes the card into the record, then composes the offer under the product lock', async () => {
      const record = givenRecord([
        { price: 1, externalId: 'SKU-OTHER', resolvedExternalId: 'SKU-OTHER' },
        {
          price: 1_499_990,
          priceWithoutDiscount: 1_599_990,
          externalId: 'SKU-1',
          resolvedExternalId: 'SKU-1',
          availability: OfferAvailability.out_of_stock,
        },
      ]);

      await expect(
        service.tryRefresh(SOURCE, completeItem() as never),
      ).resolves.toBe('refreshed');

      expect(locks.withLocks.mock.calls[0][0]).toEqual([{ namespace: 1, id: 'model-1' }]);
      expect(savedEntries()).toEqual([
        { price: 1, externalId: 'SKU-OTHER', resolvedExternalId: 'SKU-OTHER' },
        {
          price: 1_339_990,
          // A card with a price and no old price: no longer discounted.
          priceWithoutDiscount: null,
          currency: 'HUF',
          externalId: 'SKU-1',
          resolvedExternalId: 'SKU-1',
          availability: OfferAvailability.in_stock,
        },
      ]);
      // The source still lists it.
      expect(record.lastSeenAt).toBeInstanceOf(Date);
      expect(offerComposer.compose).toHaveBeenCalledWith({
        model: { id: 'model-1', sources: [record] },
        seller: SELLER,
        externalIds: ['SKU-1'],
        sighted: true,
        create: false,
      });
      expect(mergeService.recomputePrice).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'model-1' }),
      );
      expect(productRepo.save).toHaveBeenCalled();
    });

    it('leaves the stored availability alone when the card shows none', async () => {
      dynamicConfig.import = { listRefreshRequiredFields: ['url', 'price'] };
      givenRecord([
        {
          price: 1,
          externalId: 'SKU-1',
          resolvedExternalId: 'SKU-1',
          availability: OfferAvailability.out_of_stock,
        },
      ]);

      await service.tryRefresh(SOURCE, { ...completeItem(), availability: undefined } as never);

      expect(savedEntries()[0].availability).toBe(OfferAvailability.out_of_stock);
    });

    it('falls back to the sole offer when the card has no externalId', async () => {
      givenRecord([{ price: 1, externalId: 'SKU-WHATEVER', resolvedExternalId: 'SKU-WHATEVER' }]);

      const item = { ...completeItem(), externalId: undefined };

      await expect(service.tryRefresh(SOURCE, item as never)).resolves.toBe(
        'refreshed',
      );
      expect(offerComposer.compose).toHaveBeenCalledWith(
        expect.objectContaining({ externalIds: ['SKU-WHATEVER'] }),
      );
    });

    // Guessing here would write one variant's price onto another, which is
    // worse than paying for the detail fetch that resolves it properly.
    it('refuses to guess between several offers with no usable externalId', async () => {
      givenRecord([
        { price: 1, externalId: 'SKU-M', resolvedExternalId: 'SKU-M' },
        { price: 1, externalId: 'SKU-L', resolvedExternalId: 'SKU-L' },
      ]);

      const item = { ...completeItem(), externalId: undefined };

      await expect(service.tryRefresh(SOURCE, item as never)).resolves.toBe(
        'no_offer',
      );
      expect(offerComposer.compose).not.toHaveBeenCalled();
    });

    it('reports no_offer for a known record that has no offer yet', async () => {
      givenRecord([]);

      await expect(
        service.tryRefresh(SOURCE, completeItem() as never),
      ).resolves.toBe('no_offer');
      expect(offerComposer.compose).not.toHaveBeenCalled();
    });

    it('reports no_offer for a record not attached to a product', async () => {
      givenRecord([{ price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1' }], {
        model: null,
      });

      await expect(
        service.tryRefresh(SOURCE, completeItem() as never),
      ).resolves.toBe('no_offer');
      expect(locks.withLocks).not.toHaveBeenCalled();
    });

    it('reports no_offer when the offer does not exist to compose onto', async () => {
      givenRecord([{ price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1' }]);
      offerComposer.compose.mockResolvedValue({ offers: [], conflicts: [] });

      await expect(
        service.tryRefresh(SOURCE, completeItem() as never),
      ).resolves.toBe('no_offer');
      expect(mergeService.recomputePrice).not.toHaveBeenCalled();
    });

    it('looks the record up scoped to this source, with a normalized URL', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue(null);

      const item = {
        ...completeItem(),
        url: 'https://speedbike.hu/termek/macina/',
      };
      await service.tryRefresh(SOURCE, item as never);

      // Trailing slash stripped, and scoped to source-1 — an unscoped lookup
      // would hand this source another source's record for the same page.
      expect(sourceRecordRepo.findBySourceAndUrl).toHaveBeenCalledWith(
        'source-1',
        'https://speedbike.hu/termek/macina',
      );
    });
  });
});
