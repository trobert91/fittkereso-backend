import type {
  ProductModel,
  ProductSourceRecord,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import type { ProductImportContext } from '../../interfaces/product-import-context.interface';

// Only types and injected mocks from here; the gates stay real.
jest.mock('@fittkereso-backend/product', () => ({}));

import { ListingReidentificationService } from './listing-reidentification.service';
import { identityKeyOf } from './listing-identity-key';

const CATEGORY = { id: 'category-ebikes', slug: 'ebikes', name: 'E-bikes' };
const categoryConfig = {
  primarySpecs: ['gender', 'modelYear', 'torque'],
  matcherSpecs: ['batteryCapacity'],
  matchingConfig: { identifierGateExcludes: ['torque'] },
};
const keySpecs = [...categoryConfig.primarySpecs, ...categoryConfig.matcherSpecs];

describe('ListingReidentificationService', () => {
  let service: ListingReidentificationService;
  let dynamicConfig: { import: { reidentifyOnIdentityChange?: string } };
  let mergeService: { specsWithout: jest.Mock };
  let offerComposer: { currentCarriers: jest.Mock };
  let keyLookup: { lookup: jest.Mock };
  let metrics: { scrapeResolutionOutcome: jest.Mock };

  const context = (overrides: Partial<ProductImportContext> = {}) =>
    ({
      url: 'https://mangobike.hu/ktm-macina-tour-px-610',
      task: { id: 'task-1' },
      source: {
        id: 'source-1',
        name: 'mangobike',
        type: 'arukereso',
        seller: { id: 'seller-1' },
      },
      ...overrides,
    }) as unknown as ProductImportContext;

  /** The listing's record as stored: named, with its MPN and model year. */
  const ownRecord = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'record-own',
      externalId: '24384',
      source: { id: 'source-1', identifiesProducts: true },
      normalizedModel: '610 macina px tour',
      identityPinned: false,
      inputHashes: { feedIdentity: 'feed-1' },
      scrapedProduct: {
        model: 'Macina Tour PX 610',
        brand: 'KTM',
        externalId: '24384',
        modelContract: 'contract-1',
        specs: { modelYear: 2026 },
        offers: [{ externalId: '24384', mpn: '1260161111', price: 1 }],
      },
      ...overrides,
    }) as unknown as ProductSourceRecord;

  /** What the extraction made of this import: its page added gender and torque. */
  const extracted = (overrides: Partial<ScrapedProduct> = {}) =>
    ({
      category: CATEGORY,
      brand: 'KTM',
      model: 'Macina Tour PX 610',
      modelContract: 'contract-1',
      originalName: 'KTM Macina Tour PX 610',
      externalId: '24384',
      specs: { modelYear: 2026, gender: 'Férfi', torque: 90 },
      inputHashes: { feedIdentity: 'feed-1', pageIdentity: 'page-1' },
      ...overrides,
    }) as ScrapedProduct;

  const productWith = (records: Partial<ProductSourceRecord>[]) =>
    ({ id: 'model-1', sources: records }) as unknown as ProductModel;

  const otherListing = {
    id: 'record-other',
    source: { id: 'source-2', identifiesProducts: true },
  } as Partial<ProductSourceRecord>;

  const check = (
    overrides: Partial<Parameters<ListingReidentificationService['check']>[0]> = {},
  ) => {
    const record = (overrides.ownRecord ?? ownRecord()) as ProductSourceRecord;
    return service.check({
      context: context(),
      extracted: extracted(),
      normalizedModel: '610 macina px tour',
      identifiers: [{ mpn: '1260161111' }],
      externalIds: ['24384'],
      brandId: 'brand-ktm',
      product: productWith([record, otherListing]),
      ownRecord: record,
      ...overrides,
    });
  };

  const keyNow = (specs: Record<string, unknown> = { modelYear: 2026, gender: 'Férfi', torque: 90 }) =>
    identityKeyOf({
      brand: 'KTM',
      normalizedModel: '610 macina px tour',
      identifiers: [{ mpn: '1260161111' }],
      siblingIds: [],
      specs: specs as never,
      keySpecs,
    });

  beforeEach(() => {
    dynamicConfig = { import: { reidentifyOnIdentityChange: 'on' } };
    mergeService = { specsWithout: jest.fn().mockResolvedValue({}) };
    offerComposer = { currentCarriers: jest.fn().mockReturnValue([]) };
    keyLookup = { lookup: jest.fn().mockResolvedValue([]) };
    metrics = { scrapeResolutionOutcome: jest.fn() };
    service = new ListingReidentificationService(
      dynamicConfig as never,
      { getConfig: jest.fn().mockReturnValue(categoryConfig) } as never,
      mergeService as never,
      offerComposer as never,
      keyLookup as never,
      metrics as never,
    );
  });

  describe('when nothing is checked', () => {
    it('keeps no key while the mode is off', async () => {
      dynamicConfig.import.reidentifyOnIdentityChange = undefined;

      expect(await check()).toEqual({ kind: 'none' });
      expect(mergeService.specsWithout).not.toHaveBeenCalled();
    });

    it('checks no scraping source', async () => {
      expect(
        await check({ context: context({ source: { ...context().source, type: 'scraping' } } as never) }),
      ).toEqual({ kind: 'none' });
    });

    // An admin merged it there.
    it('checks no pinned listing', async () => {
      expect(await check({ ownRecord: ownRecord({ identityPinned: true }) })).toEqual({ kind: 'none' });
    });

    it('decides a listing new here under its key now', async () => {
      expect(await check({ product: undefined, ownRecord: undefined })).toEqual({
        kind: 'none',
        key: keyNow(),
      });
    });

    it('keeps the key decided before when the extraction failed', async () => {
      const result = await check({
        extracted: extracted({ model: undefined, flags: ['identity_failed'] }),
      });

      expect(result).toEqual({
        kind: 'none',
        key: identityKeyOf({
          brand: 'KTM',
          normalizedModel: '610 macina px tour',
          identifiers: [{ mpn: '1260161111' }],
          siblingIds: [],
          specs: { modelYear: 2026 },
          keySpecs,
        }),
      });
    });

    it('compares nothing for a listing that was never named', async () => {
      const result = await check({
        ownRecord: ownRecord({ scrapedProduct: { brand: 'KTM', specs: {} } }),
      });

      expect(result).toEqual({ kind: 'none', key: keyNow() });
    });

    // A new rule renames every listing at once.
    it('takes a model asked under a new rule as it is', async () => {
      const result = await check({ extracted: extracted({ modelContract: 'contract-2' }) });

      expect(result).toEqual({ kind: 'none', key: keyNow() });
      expect(keyLookup.lookup).not.toHaveBeenCalled();
    });

    it('takes a forced resync of an unchanged input as it is', async () => {
      const result = await check({
        context: context({ force: true }),
        ownRecord: ownRecord({ inputHashes: { feedIdentity: 'feed-1', pageIdentity: 'page-1' } }),
      });

      expect(result).toEqual({ kind: 'none', key: keyNow() });
    });

    it('checks a forced resync whose input changed', async () => {
      const result = await check({ context: context({ force: true }) });

      expect(result.kind).toBe('fits');
    });

    it('is nothing to check when the key is unchanged', async () => {
      const result = await check({
        ownRecord: ownRecord({ scrapedProduct: { ...ownRecord().scrapedProduct, identityKey: keyNow() } }),
      });

      expect(result).toEqual({ kind: 'none', key: keyNow() });
      expect(mergeService.specsWithout).not.toHaveBeenCalled();
    });
  });

  // Enrichment — a spec the product lacked, or one that agrees — keeps the
  // listing where it is, with no matching.
  describe('the fit check', () => {
    it('fits a gap-filled spec its product lacks', async () => {
      const result = await check();

      expect(result).toEqual({ kind: 'fits', key: keyNow() });
      expect(metrics.scrapeResolutionOutcome).toHaveBeenCalledWith('mangobike', 'reidentify_fits');
    });

    it('fits a gap-filled spec its product agrees with', async () => {
      mergeService.specsWithout.mockResolvedValue({ gender: 'Férfi', torque: 90, modelYear: 2026 });

      expect((await check()).kind).toBe('fits');
    });

    // Its own old values do not vouch for it.
    it('compares with what the product says without this listing', async () => {
      const record = ownRecord();
      const product = productWith([record, otherListing]);

      await check({ product, ownRecord: record });

      expect(mergeService.specsWithout).toHaveBeenCalledWith(product, ['record-own']);
    });

    it('does not fit a primary spec its product contradicts', async () => {
      mergeService.specsWithout.mockResolvedValue({ gender: 'Női' });

      const result = await check();

      expect(result).toEqual(
        expect.objectContaining({
          kind: 'contradicts',
          key: keyNow(),
          change: { anchorsChanged: false, addedIdentifiers: [], changedSpecs: ['gender', 'torque'] },
          alone: false,
          exclusion: {
            recordId: 'record-own',
            productId: 'model-1',
            productSpecs: { gender: 'Női' },
            ownOffers: { sellerId: 'seller-1', externalIds: ['24384'] },
          },
        }),
      );
      expect(metrics.scrapeResolutionOutcome).not.toHaveBeenCalled();
    });

    it('does not fit a matcher spec its product contradicts, found by name', async () => {
      mergeService.specsWithout.mockResolvedValue({ batteryCapacity: 500 });

      const result = await check({
        extracted: extracted({ specs: { modelYear: 2026, batteryCapacity: 750 } }),
      });

      expect(result.kind).toBe('contradicts');
    });

    // Another shop's offer with its MPN is on the product: the identifier
    // tier's gates apply, which ignore what shops get wrong.
    describe('found through another listing’s identifier', () => {
      beforeEach(() => {
        keyLookup.lookup.mockResolvedValue([{ via: 'mpn', key: '1260161111', productId: 'model-1' }]);
      });

      it('fits a torque its product states otherwise', async () => {
        mergeService.specsWithout.mockResolvedValue({ torque: 85 });

        expect((await check()).kind).toBe('fits');
      });

      it('fits a matcher spec its product states otherwise', async () => {
        mergeService.specsWithout.mockResolvedValue({ batteryCapacity: 500 });

        const result = await check({
          extracted: extracted({ specs: { modelYear: 2026, batteryCapacity: 750 } }),
        });

        expect(result.kind).toBe('fits');
      });

      it('does not fit a gender its product contradicts', async () => {
        mergeService.specsWithout.mockResolvedValue({ gender: 'Női' });

        expect((await check()).kind).toBe('contradicts');
      });
    });

    it('looks its identifiers up without its own offers', async () => {
      await check({ externalIds: ['24384', '24384-b'] });

      expect(keyLookup.lookup).toHaveBeenCalledWith({
        sourceId: 'source-1',
        siblingIds: [],
        gtins: [],
        mpns: ['1260161111'],
        brandId: 'brand-ktm',
        categoryId: 'category-ebikes',
        ownOffers: { sellerId: 'seller-1', externalIds: ['24384', '24384-b'] },
      });
    });

    it('does not fit a changed MPN, without looking anything up', async () => {
      const result = await check({ identifiers: [{ mpn: '1260169999' }] });

      expect(result.kind).toBe('contradicts');
      expect(keyLookup.lookup).not.toHaveBeenCalled();
    });

    it('does not fit a changed model', async () => {
      expect((await check({ normalizedModel: '610 macina px sport' })).kind).toBe('contradicts');
    });

    it('does not fit a new GTIN that points at another product', async () => {
      keyLookup.lookup.mockResolvedValue([{ via: 'gtin', key: '09008594503199', productId: 'model-9' }]);

      const result = await check({
        identifiers: [{ mpn: '1260161111', gtin: '09008594503199' }],
      });

      expect(result.kind).toBe('contradicts');
    });

    it('fits a new GTIN that points at its own product', async () => {
      keyLookup.lookup.mockResolvedValue([{ via: 'gtin', key: '09008594503199', productId: 'model-1' }]);

      const result = await check({
        identifiers: [{ mpn: '1260161111', gtin: '09008594503199' }],
      });

      expect(result.kind).toBe('fits');
    });

    it('reads the product as its alone when no other listing identifies it', async () => {
      mergeService.specsWithout.mockResolvedValue({ gender: 'Női' });
      const record = ownRecord();
      const contributing = { id: 'record-google', source: { id: 'source-3', identifiesProducts: false } };
      const admin = { id: 'record-admin', source: null };

      const result = await check({
        product: productWith([record, contributing as never, admin as never]),
        ownRecord: record,
      });

      expect(result).toEqual(expect.objectContaining({ kind: 'contradicts', alone: true }));
    });
  });

  // Another current listing of its seller on the product carries its offer:
  // the offer cannot follow it alone.
  describe('a listing whose offer another listing of its seller carries', () => {
    beforeEach(() => {
      mergeService.specsWithout.mockResolvedValue({ gender: 'Női' });
    });

    it('is blocked, and keeps the key decided before', async () => {
      offerComposer.currentCarriers.mockReturnValue([
        { id: 'record-own' },
        { id: 'record-scraper', source: { identifiesProducts: true } },
      ]);

      const result = await check();

      expect(result.kind).toBe('blocked');
      expect(result.key?.specs).toEqual({ modelYear: 2026 });
      expect(metrics.scrapeResolutionOutcome).toHaveBeenCalledWith('mangobike', 'reidentify_blocked');
      expect(offerComposer.currentCarriers).toHaveBeenCalledWith(
        expect.objectContaining({ sellerId: 'seller-1', externalId: '24384' }),
      );
    });

    it('is not blocked by a contributing listing, which follows the offer', async () => {
      offerComposer.currentCarriers.mockReturnValue([
        { id: 'record-google', source: { identifiesProducts: false } },
      ]);

      expect((await check()).kind).toBe('contradicts');
    });
  });
});
