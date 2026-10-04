import { ProductSourceRecordUpdaterService } from './product-source-record-updater.service';
import { hashSpecs } from '@fittkereso-backend/utils';
import type { ProductModel, ProductSourceRecord } from '@fittkereso-backend/database';

describe('ProductSourceRecordUpdaterService.upsertSourceRecord', () => {
  let service: ProductSourceRecordUpdaterService;
  let validatorService: { validateSpecs: jest.Mock };
  let productMetrics: {
    productSourceSpecValidationFailed: jest.Mock;
    sourceRecordUrlChanged: jest.Mock;
  };
  let categoryConfigService: { getJsonSchema: jest.Mock; getConfig: jest.Mock };

  const category = { slug: 'ebikes' } as any;
  const source = { id: 'source-1', name: 'speedbike', config: {} } as any;

  function makeModel(existingSource?: Partial<ProductSourceRecord>): ProductModel {
    return {
      productCategory: category,
      sources: existingSource ? [existingSource as ProductSourceRecord] : [],
    } as ProductModel;
  }

  beforeEach(() => {
    validatorService = {
      validateSpecs: jest.fn().mockReturnValue({ isValid: true, errors: {} }),
    };
    productMetrics = {
      productSourceSpecValidationFailed: jest.fn(),
      sourceRecordUrlChanged: jest.fn(),
    };
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue(undefined),
      getConfig: jest.fn().mockReturnValue(undefined),
    };

    service = new ProductSourceRecordUpdaterService(
      validatorService as any,
      productMetrics as any,
      categoryConfigService as any,
    );
  });

  it('skips extraction entirely when scrapedProduct is undefined and a matching source row already exists', async () => {
    const existingSource: Partial<ProductSourceRecord> = {
      source,
      url: 'https://speedbike.hu/product-1',
      externalId: 'product-1',
      scrapedProduct: { specs: { weight: 22 } },
      offerSpecsHash: 'abc123',
      productSpecsHash: 'def456',
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(existingSource);

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: undefined,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result).toBe(existingSource);
    expect(existingSource.lastUpdated).toEqual(new Date('2026-01-01')); // untouched
    // The source still lists it, even though nothing about it changed.
    expect(existingSource.lastSeenAt).toBeInstanceOf(Date);
  });

  it('stamps lastSeenAt on a listing it writes, and never on the admin record', async () => {
    const model = makeModel();

    const listing = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: { specs: { weight: 22 } } as any,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });
    const manual = await service.upsertSourceRecord({
      model,
      source: null,
      scrapedProduct: { specs: { weight: 23 } } as any,
    });

    expect(listing?.lastSeenAt).toBeInstanceOf(Date);
    expect(manual?.lastSeenAt).toBeUndefined();
  });

  it("keeps the admin's description when a manual-specs save writes the admin record", async () => {
    const adminRecord: Partial<ProductSourceRecord> = {
      source: null,
      scrapedProduct: { specs: { weight: 21 }, description: 'Az admin szövege.' },
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(adminRecord);

    const result = await service.upsertSourceRecord({
      model,
      source: null,
      scrapedProduct: { specs: { weight: 23 } } as any,
    });

    expect(result).toBe(adminRecord);
    expect(result?.scrapedProduct).toEqual({ specs: { weight: 23 }, description: 'Az admin szövege.' });
    expect(model.sources).toHaveLength(1);
  });

  it("replaces a source's listing wholesale: a description it no longer has goes", async () => {
    const model = makeModel({
      source,
      url: 'https://speedbike.hu/product-1',
      externalId: 'product-1',
      scrapedProduct: { specs: { weight: 22 }, description: 'régi' },
    });

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: { specs: { weight: 22 } } as any,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result?.scrapedProduct?.description).toBeUndefined();
  });

  it('creates/updates the source row when scrapedProduct is provided, persisting the hashes supplied by the caller as given', async () => {
    const model = makeModel();

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 22 },
        offerLevelDeterministicSpecs: { frameSize: 43 },
        productLevelDeterministicSpecs: { weight: 22 },
        offerSpecsHash: hashSpecs({ frameSize: 43 }),
        productSpecsHash: hashSpecs({ weight: 22 }),
      } as any,
      externalId: 'sku-123',
      sourceUrl: 'https://speedbike.hu/product-1',
      normalizedModel: 'macina scarp',
    });

    expect(result).toBeDefined();
    expect(result?.normalizedModel).toBe('macina scarp');
    expect(result?.scrapedProduct?.specs).toEqual({ weight: 22 });
    expect(result?.offerSpecsHash).toBe(hashSpecs({ frameSize: 43 }));
    expect(result?.productSpecsHash).toBe(hashSpecs({ weight: 22 }));
    expect(result?.externalId).toBe('sku-123');
    expect(model.sources).toHaveLength(1);
  });

  it("stores a feed row's hash, and keeps it when a scrape passes none", async () => {
    const model = makeModel();
    const upsert = (feedRowHash?: string) =>
      service.upsertSourceRecord({
        model,
        source,
        scrapedProduct: { specs: { weight: 22 } } as any,
        externalId: 'product-1',
        sourceUrl: 'https://speedbike.hu/product-1',
        feedRowHash,
      });

    await upsert('row-hash-1');
    const record = await upsert(undefined);

    expect(record?.feedRowHash).toBe('row-hash-1');
    expect(model.sources).toHaveLength(1);
  });

  it('re-writes the row when the caller supplies a new productSpecsHash, even if scrapedProduct is present', async () => {
    const existingSource: Partial<ProductSourceRecord> = {
      source,
      url: 'https://speedbike.hu/product-1',
      externalId: 'product-1',
      scrapedProduct: { specs: { weight: 22 } },
      productSpecsHash: hashSpecs({ weight: 22 }),
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(existingSource);

    await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 23 },
        productLevelDeterministicSpecs: { weight: 23 },
        productSpecsHash: hashSpecs({ weight: 23 }),
      } as any,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(existingSource.productSpecsHash).toBe(hashSpecs({ weight: 23 }));
  });

  it('trusts the caller-supplied hash even if it does not match what processSpecs would derive from productLevelDeterministicSpecs, since the hash and the LLM-call decision must agree on the same pre-computed value', async () => {
    const model = makeModel();

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 22 },
        productLevelDeterministicSpecs: { weight: 22 },
        productSpecsHash: 'caller-computed-hash',
      } as any,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result?.productSpecsHash).toBe('caller-computed-hash');
  });

  it('always processes when scrapedProduct is provided even without a prior source row', async () => {
    const model = makeModel();

    await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: { specs: { weight: 22 } } as any,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(model.sources).toHaveLength(1);
  });

  it('does not skip when scrapedProduct is undefined but no matching source row exists yet', async () => {
    const model = makeModel(); // no existing sources

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: undefined,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    // Falls through to normal processing with an empty specs object — this
    // is the manual-edit / first-scrape path, not the "unchanged" skip path.
    expect(result).toBeDefined();
    expect(model.sources).toHaveLength(1);
  });

  it('skips extraction when scrapedProduct is defined but specs is undefined (both hashes unchanged rescrape) and a matching source row already exists', async () => {
    // Mirrors ProductDetailsPageScraperService.extractProduct's
    // both-hashes-unchanged branch: it returns a full ScrapedProduct
    // (brand/model/offers/...) but omits specs/rawSpecs — it must
    // not be treated as "new data to write", or it wipes the existing row's
    // specs with {}.
    const existingSource: Partial<ProductSourceRecord> = {
      source,
      url: 'https://speedbike.hu/product-1',
      externalId: 'product-1',
      scrapedProduct: { specs: { weight: 22 } },
      offerSpecsHash: 'abc123',
      productSpecsHash: 'def456',
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(existingSource);

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        brand: 'KTM',
        model: 'Macina Scarp',
      } as any,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result).toBe(existingSource);
    expect(existingSource.scrapedProduct?.specs).toEqual({ weight: 22 });
    expect(existingSource.lastUpdated).toEqual(new Date('2026-01-01')); // untouched
  });

  it('never writes through another source\'s record of the same listing', async () => {
    // One webshop can be covered by several ProductSources (an Árukereső feed
    // and a Google feed), both keyed by the shop's own id — so `model.sources`,
    // which is loaded across ALL sources, can hold two rows with this same
    // externalId and URL.
    //
    // Matching without the source picked whichever came first. Source B then
    // overwrote source A's scrapedProduct and hashes, while the row stayed
    // attributed to A (source.source is assigned on create only). A's data was
    // silently replaced by B's under A's merge priority, and B never got a
    // record of its own. This is the regression guard for that.
    const otherSourcesRecord: Partial<ProductSourceRecord> = {
      source: { id: 'source-2', name: 'speedbike-arukereso' } as any,
      url: 'https://speedbike.hu/product-1',
      externalId: 'product-1',
      scrapedProduct: { specs: { weight: 99 } },
      offerSpecsHash: 'other-offer-hash',
      productSpecsHash: 'other-product-hash',
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(otherSourcesRecord);

    const result = await service.upsertSourceRecord({
      model,
      source, // source-1
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 23 },
      } as any,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    // A second, independent record — not a write through the other source's.
    expect(result).not.toBe(otherSourcesRecord);
    expect(model.sources).toHaveLength(2);
    expect(result?.source).toBe(source);

    // The other source's row is untouched in every field this call would have
    // overwritten.
    expect(otherSourcesRecord.scrapedProduct?.specs).toEqual({ weight: 99 });
    expect(otherSourcesRecord.offerSpecsHash).toBe('other-offer-hash');
    expect(otherSourcesRecord.productSpecsHash).toBe('other-product-hash');
    expect(otherSourcesRecord.url).toBe('https://speedbike.hu/product-1');
    expect(otherSourcesRecord.lastUpdated).toEqual(new Date('2026-01-01'));
  });

  describe('a listing the shop renamed', () => {
    const OLD_URL = 'https://speedbike.hu/ktm-macina-burnt-orange-matt-szinben';
    const NEW_URL = 'https://speedbike.hu/ktm-macina-burnt-orange-matt-szinben-2026';

    function renamedModel(): { model: ProductModel; record: Partial<ProductSourceRecord> } {
      const record: Partial<ProductSourceRecord> = {
        id: 'record-1',
        source,
        url: OLD_URL,
        externalId: '1260042108',
        scrapedProduct: {
          specs: { weight: 22 },
          offers: [
            // Stored before resolvedExternalId existed: its id derives from the URL.
            { price: 1, url: OLD_URL } as any,
            { price: 2, url: 'https://speedbike.hu/other', resolvedExternalId: 'SKU-2' } as any,
          ],
        },
        lastUpdated: new Date('2026-01-01'),
      };
      return { model: makeModel(record), record };
    }

    it('moves the record to the new URL instead of adding a second one', async () => {
      const { model, record } = renamedModel();

      const result = await service.upsertSourceRecord({
        model,
        source,
        scrapedProduct: { specs: { weight: 22 } } as any,
        externalId: '1260042108',
        sourceUrl: `${NEW_URL}/`,
      });

      expect(result).toBe(record);
      expect(model.sources).toHaveLength(1);
      expect(record.url).toBe(NEW_URL);
      expect(productMetrics.sourceRecordUrlChanged).toHaveBeenCalledWith('speedbike');
    });

    // The stored entries, when the import writes no new ones (an unchanged page).
    it('pins each stored entry to the id its offer is under, and points it at the new page', async () => {
      const { model, record } = renamedModel();

      await service.upsertSourceRecord({
        model,
        source,
        scrapedProduct: { brand: 'KTM' } as any,
        externalId: '1260042108',
        sourceUrl: NEW_URL,
      });

      expect(record.url).toBe(NEW_URL);
      expect(record.scrapedProduct?.offers).toEqual([
        { price: 1, url: NEW_URL, resolvedExternalId: 'ktm-macina-burnt-orange-matt-szinben' },
        { price: 2, url: 'https://speedbike.hu/other', resolvedExternalId: 'SKU-2' },
      ]);
    });

    it('counts nothing when the URL is the same', async () => {
      const { model } = renamedModel();

      await service.upsertSourceRecord({
        model,
        source,
        scrapedProduct: { specs: { weight: 22 } } as any,
        externalId: '1260042108',
        sourceUrl: OLD_URL,
      });

      expect(productMetrics.sourceRecordUrlChanged).not.toHaveBeenCalled();
    });
  });

  // Without it, the record could not be found again, and each import would add one.
  it("refuses a source's listing without its externalId", async () => {
    await expect(
      service.upsertSourceRecord({
        model: makeModel(),
        source,
        scrapedProduct: { specs: { weight: 22 } } as any,
        sourceUrl: 'https://speedbike.hu/product-1',
      }),
    ).rejects.toThrow('without the externalId');
  });

  it('sets both hashes to undefined when scrapedProduct has no offerLevelDeterministicSpecs/productLevelDeterministicSpecs', async () => {
    const model = makeModel();

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: { model: 'Macina Scarp', specs: { weight: 22 } } as any,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result?.offerSpecsHash).toBeUndefined();
    expect(result?.productSpecsHash).toBeUndefined();
  });

  it('persists offerLevelDeterministicSpecs/productLevelDeterministicSpecs on the row, sorted/filtered like other spec fields', async () => {
    const model = makeModel();

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 22 },
        offerLevelDeterministicSpecs: { frameSize: 43, color: undefined },
        productLevelDeterministicSpecs: { weight: 22, torque: '' },
      } as any,
      externalId: 'product-1',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result?.scrapedProduct?.offerLevelDeterministicSpecs).toEqual({ frameSize: 43 });
    expect(result?.scrapedProduct?.productLevelDeterministicSpecs).toEqual({ weight: 22 });
  });
});

describe('ProductSourceRecordUpdaterService.upsertUnattached', () => {
  let service: ProductSourceRecordUpdaterService;
  let validatorService: { validateSpecs: jest.Mock };
  let categoryConfigService: { getJsonSchema: jest.Mock; getConfig: jest.Mock };
  let productMetrics: { productSourceSpecValidationFailed: jest.Mock; sourceRecordUrlChanged: jest.Mock };

  const google = { id: 'source-google', name: 'speedbike-googleshop' } as any;
  const haibike = { id: 'brand-haibike', name: 'Haibike' } as any;
  const listing = {
    model: 'SDURO',
    originalName: 'HAIBIKE SDURO 2026 M',
    category: { id: 'category-1', slug: 'ebikes', name: 'E-bikes' },
    specs: { weight: 22, motor: undefined },
    offers: [{ price: 1499990, priceWithoutDiscount: 2269000, resolvedExternalId: 'HAIBIKE-1' }],
  } as any;

  beforeEach(() => {
    validatorService = {
      validateSpecs: jest.fn().mockReturnValue({ isValid: false, errors: { weight: 'bad' } }),
    };
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue({ type: 'object' }),
      getConfig: jest.fn().mockReturnValue(undefined),
    };
    productMetrics = {
      productSourceSpecValidationFailed: jest.fn(),
      sourceRecordUrlChanged: jest.fn(),
    };
    service = new ProductSourceRecordUpdaterService(
      validatorService as any,
      productMetrics as any,
      categoryConfigService as any,
    );
  });

  // The same record an attached listing gets, so it attaches as it is.
  it('writes the listing as any listing is, with no product', () => {
    const record = service.upsertUnattached({
      existing: null,
      source: google,
      scrapedProduct: listing,
      externalId: 'HAIBIKE-1',
      sourceUrl: 'https://speedbike.hu/haibike/',
      brand: haibike,
      feedRowHash: 'hash-1',
    });

    expect(record).toMatchObject({
      product: null,
      source: google,
      url: 'https://speedbike.hu/haibike',
      externalId: 'HAIBIKE-1',
      brand: haibike,
      model: 'SDURO',
      originalTitle: 'HAIBIKE SDURO 2026 M',
      feedRowHash: 'hash-1',
      specValid: false,
      specErrors: { weight: 'bad' },
    });
    expect(record.scrapedProduct?.specs).toEqual({ weight: 22 });
    expect(record.scrapedProduct?.offers).toEqual(listing.offers);
    expect(record.lastSeenAt).toBeInstanceOf(Date);
    expect(categoryConfigService.getJsonSchema).toHaveBeenCalledWith('ebikes');
  });

  it('updates the record it already has for the listing', () => {
    const existing = {
      id: 'record-google',
      product: null,
      url: 'https://speedbike.hu/haibike',
      feedRowHash: 'old',
    } as any;

    const record = service.upsertUnattached({
      existing,
      source: google,
      scrapedProduct: listing,
      externalId: 'HAIBIKE-1',
      sourceUrl: 'https://speedbike.hu/haibike',
      feedRowHash: 'hash-2',
    });

    expect(record).toBe(existing);
    expect(record.feedRowHash).toBe('hash-2');
    expect(productMetrics.sourceRecordUrlChanged).not.toHaveBeenCalled();
  });

  it('moves the record it already has when the shop renamed the listing', () => {
    const existing = {
      id: 'record-google',
      product: null,
      url: 'https://speedbike.hu/haibike',
      externalId: 'HAIBIKE-1',
    } as any;

    const record = service.upsertUnattached({
      existing,
      source: google,
      scrapedProduct: listing,
      externalId: 'HAIBIKE-1',
      sourceUrl: 'https://speedbike.hu/haibike-2026',
    });

    expect(record).toBe(existing);
    expect(record.url).toBe('https://speedbike.hu/haibike-2026');
    expect(productMetrics.sourceRecordUrlChanged).toHaveBeenCalledWith('speedbike-googleshop');
  });

  // A contributing source's record keeps no key; one stored before that goes.
  it('stores the normalizedModel it is given, clears it on null and keeps it when none is passed', () => {
    const existing = { id: 'record-ktm', product: null, normalizedModel: '810 di macina style' } as any;
    const upsert = (normalizedModel?: string | null) =>
      service.upsertUnattached({
        existing,
        source: google,
        scrapedProduct: listing,
        sourceUrl: 'https://speedbike.hu/haibike',
        normalizedModel,
      });

    upsert();
    expect(existing.normalizedModel).toBe('810 di macina style');
    upsert('sduro');
    expect(existing.normalizedModel).toBe('sduro');
    upsert(null);
    expect(existing.normalizedModel).toBeNull();
  });

  it('keeps the brand when none is passed', () => {
    const existing = { id: 'record-google', product: null, brand: haibike } as any;

    service.upsertUnattached({
      existing,
      source: google,
      scrapedProduct: listing,
      sourceUrl: 'https://speedbike.hu/haibike',
    });

    expect(existing.brand).toBe(haibike);
  });

  // A listing the extraction did not name keeps its title, and no model.
  it('writes no model for a listing without one', () => {
    const record = service.upsertUnattached({
      existing: null,
      source: google,
      scrapedProduct: { ...listing, model: undefined },
      sourceUrl: 'https://speedbike.hu/haibike',
    });

    expect(record.model).toBeNull();
    expect(record.originalTitle).toBe('HAIBIKE SDURO 2026 M');
  });
});
