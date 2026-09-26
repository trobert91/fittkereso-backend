import { OfferAvailability, type ScrapedOffer } from '@fittkereso-backend/database';
import {
  DEFAULT_LIST_REFRESH_REQUIRED_FIELDS,
  ListProductRefreshService,
} from './list-product-refresh.service';

const SELLER = { id: 'seller-1' };
const SOURCE = {
  id: 'source-1',
  name: 'speedbike',
  seller: SELLER,
  detailRefreshInterval: '60 days',
} as never;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

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
  let sourceRecordRepo: {
    findBySourceAndUrl: jest.Mock;
    findUniqueBySourceAndExternalId: jest.Mock;
    findById: jest.Mock;
    save: jest.Mock;
  };
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
      // Well inside the interval: its detail page is not due yet.
      lastUpdated: daysAgo(1),
      lastSeenAt: undefined as Date | undefined,
      ...overrides,
    };
    sourceRecordRepo.findBySourceAndUrl.mockResolvedValue(record);
    sourceRecordRepo.findById.mockResolvedValue(record);
    productRepo.findOne.mockResolvedValue({ id: 'model-1', sources: [record] });
    return record;
  };
  const savedEntries = (): ScrapedOffer[] =>
    sourceRecordRepo.save.mock.calls[0][0].scrapedProduct.offers;

  beforeEach(() => {
    sourceRecordRepo = {
      findBySourceAndUrl: jest.fn(),
      // Unmatched by externalId unless a test says so: looked up by URL.
      findUniqueBySourceAndExternalId: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
      save: jest.fn(),
    };
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

  // A card never shows a new GTIN, spec, description or store list, so a
  // listing refreshed from its cards alone would keep its first detail
  // scrape's forever. Each listing falls due between 75% and 100% of the
  // interval after its last detail import (detail-refresh-schedule).
  describe('stale listings', () => {
    const entry = { price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1' };

    it('sends a listing past the interval to a detail scrape, however complete its card', async () => {
      givenRecord([entry], { lastUpdated: daysAgo(61) });

      await expect(service.tryRefresh(SOURCE, completeItem() as never)).resolves.toBe('stale');
      expect(sourceRecordRepo.save).not.toHaveBeenCalled();
      expect(offerComposer.compose).not.toHaveBeenCalled();
    });

    it('refreshes in place a listing younger than the earliest due date', async () => {
      givenRecord([entry], { lastUpdated: daysAgo(44) });

      await expect(service.tryRefresh(SOURCE, completeItem() as never)).resolves.toBe('refreshed');
    });

    it("reads the source's own interval", async () => {
      givenRecord([entry], { lastUpdated: daysAgo(8) });
      const weekly = { ...(SOURCE as object), detailRefreshInterval: '7 days' };

      await expect(service.tryRefresh(weekly as never, completeItem() as never)).resolves.toBe('stale');
    });

    it('reports a thin card as incomplete before its age', async () => {
      givenRecord([entry], { lastUpdated: daysAgo(61) });

      await expect(
        service.tryRefresh(SOURCE, { ...completeItem(), availability: undefined } as never),
      ).resolves.toBe('incomplete');
    });

    // lastUpdated is what dates the detail import; the in-place refresh only
    // says the source still lists the item.
    it('leaves lastUpdated alone when refreshing in place', async () => {
      const lastUpdated = daysAgo(10);
      const record = givenRecord([entry], { lastUpdated });

      await service.tryRefresh(SOURCE, completeItem() as never);

      expect(record.lastUpdated).toBe(lastUpdated);
      expect(record.lastSeenAt).toBeInstanceOf(Date);
    });

    it('says when the detail page falls due', async () => {
      const record = givenRecord([entry], { lastUpdated: daysAgo(1) });

      const decision = await service.decide(SOURCE, completeItem() as never);

      expect(decision.outcome).toBe('refresh');
      const age = (decision.detailDueAt as Date).getTime() - record.lastUpdated.getTime();
      expect(age).toBeGreaterThanOrEqual(45 * DAY);
      expect(age).toBeLessThanOrEqual(60 * DAY);
    });
  });

  // A shop that renames a product changes its slug but keeps its code: found
  // by (source, externalId), the card refreshes the listing it always was, and
  // the record follows it to the new URL.
  describe('listings found by externalId', () => {
    const OLD_URL = 'https://ebikeshop.hu/termek/ktm-macina-old-name';
    const NEW_URL = 'https://ebikeshop.hu/termek/ktm-macina-new-name';
    const card = () => ({ ...completeItem(), url: NEW_URL, externalId: 'SKU-1' });

    /** This source's record of SKU-1, still under its old URL. */
    const givenMovedRecord = (offers: ScrapedOffer[], overrides: Record<string, unknown> = {}) => {
      const record = givenRecord(offers, { url: OLD_URL, externalId: 'SKU-1', ...overrides });
      sourceRecordRepo.findUniqueBySourceAndExternalId.mockResolvedValue(record);
      // Nothing else of this source holds the new URL.
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue(null);
      return record;
    };

    it('refreshes it in place and moves the record and its offer entry to the new URL', async () => {
      const record = givenMovedRecord([
        { price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1', url: OLD_URL },
        { price: 1, externalId: 'SKU-2', resolvedExternalId: 'SKU-2', url: 'https://ebikeshop.hu/termek/other' },
      ]);

      await expect(service.tryRefresh(SOURCE, card() as never)).resolves.toBe('refreshed');

      expect(sourceRecordRepo.findUniqueBySourceAndExternalId).toHaveBeenCalledWith('source-1', 'SKU-1');
      expect(record.url).toBe(NEW_URL);
      const entries = record.scrapedProduct.offers as ScrapedOffer[];
      expect(entries.map((offer) => offer.url)).toEqual([NEW_URL, 'https://ebikeshop.hu/termek/other']);
      expect(entries[0].price).toBe(1_339_990);
      // One lock for the move and the refresh together.
      expect(locks.withLocks).toHaveBeenCalledTimes(1);
      expect(offerComposer.compose).toHaveBeenCalledWith(
        expect.objectContaining({ externalIds: ['SKU-1'] }),
      );
    });

    // Otherwise the detail scrape it still needs would write a second record
    // under the new URL, beside the old one.
    it('moves it even when the card sends it to a detail scrape', async () => {
      const record = givenMovedRecord(
        [{ price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1', url: OLD_URL }],
        { lastUpdated: daysAgo(61) },
      );

      await expect(service.tryRefresh(SOURCE, card() as never)).resolves.toBe('stale');

      expect(record.url).toBe(NEW_URL);
      expect(sourceRecordRepo.save).toHaveBeenCalledTimes(1);
      expect(offerComposer.compose).not.toHaveBeenCalled();
    });

    it('pins the id an entry derived from its old URL before moving it', async () => {
      const record = givenMovedRecord([{ price: 1, url: OLD_URL }]);

      await service.tryRefresh(SOURCE, card() as never);

      expect((record.scrapedProduct.offers as ScrapedOffer[])[0]).toMatchObject({
        url: NEW_URL,
        resolvedExternalId: 'termek/ktm-macina-old-name',
      });
    });

    it('does not guess when another record of the source holds the new URL', async () => {
      const record = givenMovedRecord([
        { price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1', url: OLD_URL },
      ]);
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue({ id: 'record-2', url: NEW_URL });

      await expect(service.tryRefresh(SOURCE, card() as never)).resolves.toBe('moved');

      expect(record.url).toBe(OLD_URL);
      expect(sourceRecordRepo.save).not.toHaveBeenCalled();
      expect(locks.withLocks).not.toHaveBeenCalled();
    });

    it('writes nothing when the record moved meanwhile', async () => {
      const record = givenMovedRecord([
        { price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1', url: OLD_URL },
      ]);
      sourceRecordRepo.findById.mockResolvedValue({ ...record, url: 'https://ebikeshop.hu/termek/elsewhere' });
      productRepo.findOne.mockResolvedValue({ id: 'model-1', sources: [] });

      await expect(service.tryRefresh(SOURCE, card() as never)).resolves.toBe('no_offer');

      expect(sourceRecordRepo.save).not.toHaveBeenCalled();
    });

    // The repository answers null for an id several records share (a
    // group-level id), and the card is then looked up by its URL.
    it('falls back to the URL when no single record carries the externalId', async () => {
      givenRecord([{ price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1' }]);

      await expect(service.tryRefresh(SOURCE, completeItem() as never)).resolves.toBe('refreshed');

      expect(sourceRecordRepo.findUniqueBySourceAndExternalId).toHaveBeenCalledWith('source-1', 'SKU-1');
      expect(sourceRecordRepo.findBySourceAndUrl).toHaveBeenCalledWith(
        'source-1',
        'https://speedbike.hu/termek/macina',
      );
    });

    // No product lock to move it under; it keeps its URL, as before.
    it('falls back to the URL for an unattached record', async () => {
      givenMovedRecord([{ price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1' }], {
        model: null,
      });

      await expect(service.tryRefresh(SOURCE, card() as never)).resolves.toBe('unknown');
      expect(sourceRecordRepo.save).not.toHaveBeenCalled();
    });

    it('looks a card without an externalId up by URL only', async () => {
      givenRecord([{ price: 1, externalId: 'SKU-1', resolvedExternalId: 'SKU-1' }]);

      await service.tryRefresh(SOURCE, { ...completeItem(), externalId: undefined } as never);

      expect(sourceRecordRepo.findUniqueBySourceAndExternalId).not.toHaveBeenCalled();
    });
  });
});
