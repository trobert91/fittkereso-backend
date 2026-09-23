import { OfferAvailability } from '@fittkereso-backend/database';
import {
  DEFAULT_LIST_REFRESH_REQUIRED_FIELDS,
  ListProductRefreshService,
} from './list-product-refresh.service';

const SOURCE = { id: 'source-1', name: 'speedbike' } as never;

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
  let sourceRecordRepo: { findBySourceAndUrl: jest.Mock };
  let offerRepo: { refreshFromListProduct: jest.Mock };
  let dynamicConfig: { import?: { listRefreshRequiredFields?: string[] } };

  beforeEach(() => {
    sourceRecordRepo = { findBySourceAndUrl: jest.fn() };
    offerRepo = { refreshFromListProduct: jest.fn() };
    dynamicConfig = {};

    service = new ListProductRefreshService(
      sourceRecordRepo as never,
      offerRepo as never,
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
      expect(offerRepo.refreshFromListProduct).not.toHaveBeenCalled();
    });

    it('reports incomplete and writes nothing when the card is too thin', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue({
        id: 'record-1',
        offers: [{ id: 'offer-1', externalId: 'SKU-1' }],
      });

      const item = { ...completeItem(), availability: undefined };

      await expect(service.tryRefresh(SOURCE, item as never)).resolves.toBe(
        'incomplete',
      );
      expect(offerRepo.refreshFromListProduct).not.toHaveBeenCalled();
    });

    it('refreshes the offer matching the card externalId', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue({
        id: 'record-1',
        offers: [
          { id: 'offer-other', externalId: 'SKU-OTHER' },
          { id: 'offer-1', externalId: 'SKU-1' },
        ],
      });

      await expect(
        service.tryRefresh(SOURCE, completeItem() as never),
      ).resolves.toBe('refreshed');

      expect(offerRepo.refreshFromListProduct).toHaveBeenCalledWith('offer-1', {
        price: 1_339_990,
        priceWithoutDiscount: undefined,
        currency: 'HUF',
        availability: OfferAvailability.in_stock,
      });
    });

    it('falls back to the sole offer when the card has no externalId', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue({
        id: 'record-1',
        offers: [{ id: 'offer-only', externalId: 'SKU-WHATEVER' }],
      });

      const item = { ...completeItem(), externalId: undefined };

      await expect(service.tryRefresh(SOURCE, item as never)).resolves.toBe(
        'refreshed',
      );
      expect(offerRepo.refreshFromListProduct).toHaveBeenCalledWith(
        'offer-only',
        expect.anything(),
      );
    });

    // Guessing here would write one variant's price onto another, which is
    // worse than paying for the detail fetch that resolves it properly.
    it('refuses to guess between several offers with no usable externalId', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue({
        id: 'record-1',
        offers: [
          { id: 'offer-m', externalId: 'SKU-M' },
          { id: 'offer-l', externalId: 'SKU-L' },
        ],
      });

      const item = { ...completeItem(), externalId: undefined };

      await expect(service.tryRefresh(SOURCE, item as never)).resolves.toBe(
        'no_offer',
      );
      expect(offerRepo.refreshFromListProduct).not.toHaveBeenCalled();
    });

    it('reports no_offer for a known record that has no offer yet', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue({
        id: 'record-1',
        offers: [],
      });

      await expect(
        service.tryRefresh(SOURCE, completeItem() as never),
      ).resolves.toBe('no_offer');
      expect(offerRepo.refreshFromListProduct).not.toHaveBeenCalled();
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
