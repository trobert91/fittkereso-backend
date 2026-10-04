import type { ProductSourceRecord, ScrapedProduct } from '@fittkereso-backend/database';
import { productLock } from '@fittkereso-backend/database';
import { ListingModelRefreshService } from './listing-model-refresh.service';

describe('ListingModelRefreshService', () => {
  const CONTRACT = 'contract-now';
  let sourceRecordRepo: { findForModelRefresh: jest.Mock; setModel: jest.Mock };
  let specPostProcess: {
    modelContractOf: jest.Mock;
    identityEnabledFor: jest.Mock;
    extractIdentity: jest.Mock;
  };
  let matchQuery: { normalizedModelOf: jest.Mock };
  let listingColumns: { fill: jest.Mock };
  let productRepo: { findOne: jest.Mock; save: jest.Mock };
  let mergeService: { mergeSources: jest.Mock };
  let locks: { withLocks: jest.Mock };
  let service: ListingModelRefreshService;

  const source = { id: 'source-1', name: 'akosbike-arukereso', config: {} };
  const recordOf = (
    id: string,
    listing: Partial<ScrapedProduct> = {},
    productId: string | null = 'product-1',
  ): ProductSourceRecord =>
    ({
      id,
      url: `https://akosbike.hu/${id}`,
      source,
      product: productId ? { id: productId } : null,
      brand: { id: 'brand-cube', name: 'Cube' },
      scrapedProduct: {
        brand: 'CUBE',
        model: 'Kathmandu Hybrid ONE',
        originalName: 'Cube Kathmandu Hybrid ONE 800 2025 54',
        category: { id: 'cat-1', slug: 'ebikes', name: 'E-bikes' },
        ...listing,
      },
    }) as unknown as ProductSourceRecord;

  const run = (overrides: Partial<Parameters<ListingModelRefreshService['refresh']>[0]> = {}) =>
    service.refresh({ dryRun: false, limit: 100, concurrency: 2, ...overrides });

  beforeEach(() => {
    sourceRecordRepo = {
      findForModelRefresh: jest.fn().mockResolvedValue([]),
      setModel: jest.fn().mockResolvedValue(undefined),
    };
    specPostProcess = {
      modelContractOf: jest.fn().mockReturnValue(CONTRACT),
      identityEnabledFor: jest.fn().mockReturnValue(true),
      extractIdentity: jest.fn(async ({ scrapedProduct }) => ({
        ...scrapedProduct,
        model: 'Kathmandu Hybrid ONE 800',
        modelContract: CONTRACT,
        // Whatever the call says about the specs, only the model is written.
        specs: { modelYear: 2030 },
      })),
    };
    matchQuery = {
      normalizedModelOf: jest.fn(
        (listing: ScrapedProduct, brandName?: string) => `key:${listing.model}:${brandName}`,
      ),
    };
    listingColumns = { fill: jest.fn().mockResolvedValue({ read: 5, changed: 3 }) };
    productRepo = {
      findOne: jest.fn(async ({ where }) => ({ id: where.id, sources: [] })),
      save: jest.fn(async (product) => product),
    };
    mergeService = { mergeSources: jest.fn(async (product) => product) };
    locks = { withLocks: jest.fn(async (_keys, fn: () => Promise<unknown>) => fn()) };
    service = new ListingModelRefreshService(
      sourceRecordRepo as never,
      specPostProcess as never,
      matchQuery as never,
      listingColumns as never,
      productRepo as never,
      mergeService as never,
      locks as never,
    );
  });

  it('fills every listing\x27s record columns first, with the same filters', async () => {
    const summary = await run({ sourceId: 'source-1', categorySlug: 'ebikes' });

    expect(listingColumns.fill).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, sourceId: 'source-1', categorySlug: 'ebikes' }),
    );
    expect(summary.columns).toEqual({ read: 5, changed: 3 });
    expect(sourceRecordRepo.findForModelRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ named: true, sourceId: 'source-1', categorySlug: 'ebikes' }),
    );
  });

  it('reads only the listings it is given, in both passes', async () => {
    await run({ recordIds: ['r1', 'r2'] });

    expect(listingColumns.fill).toHaveBeenCalledWith(expect.objectContaining({ recordIds: ['r1', 'r2'] }));
    expect(sourceRecordRepo.findForModelRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ named: true, recordIds: ['r1', 'r2'] }),
    );
  });

  it('asks each due listing as its own last import, and writes only its model, contract and key', async () => {
    const record = recordOf('r1');
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([record]);

    const summary = await run();

    expect(specPostProcess.extractIdentity).toHaveBeenCalledWith({
      context: { source, url: 'https://akosbike.hu/r1' },
      scrapedProduct: record.scrapedProduct,
      ownRecord: record,
    });
    expect(sourceRecordRepo.setModel).toHaveBeenCalledWith('r1', {
      model: 'Kathmandu Hybrid ONE 800',
      contract: CONTRACT,
      // Keyed with the record's resolved brand, as an import keys it.
      key: 'key:Kathmandu Hybrid ONE 800:Cube',
    });
    expect(summary).toMatchObject({ read: 1, asked: 1, written: 1, failed: 0, more: false });
  });

  it('names each renamed listing\x27s product again under its lock, once per product', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([
      recordOf('r1', {}, 'product-1'),
      recordOf('r2', {}, 'product-1'),
    ]);

    const summary = await run();

    expect(locks.withLocks).toHaveBeenCalledTimes(1);
    expect(locks.withLocks).toHaveBeenCalledWith([productLock('product-1')], expect.any(Function));
    expect(productRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'product-1' } }),
    );
    expect(mergeService.mergeSources).toHaveBeenCalledWith({ id: 'product-1', sources: [] });
    expect(productRepo.save).toHaveBeenCalledWith({ id: 'product-1', sources: [] });
    expect(summary.productsMerged).toBe(1);
  });

  // Written under the lock: an import holding the product saves its records back.
  it('writes the listing under its product\x27s lock, before the product is read again', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([recordOf('r1')]);
    const order: string[] = [];
    locks.withLocks.mockImplementation(async (_keys, fn: () => Promise<unknown>) => {
      order.push('lock');
      return fn();
    });
    sourceRecordRepo.setModel.mockImplementation(async () => order.push('write'));
    productRepo.findOne.mockImplementation(async () => {
      order.push('read');
      return { id: 'product-1' };
    });

    await run();

    expect(order).toEqual(['lock', 'write', 'read']);
  });

  it('writes an unattached listing with no product to name', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([recordOf('r1', {}, null)]);

    const summary = await run();

    expect(sourceRecordRepo.setModel).toHaveBeenCalledTimes(1);
    expect(locks.withLocks).not.toHaveBeenCalled();
    expect(summary.productsMerged).toBe(0);
  });

  it('skips listings under the current contract, stored without a title, or of a source with the extraction off', async () => {
    const offSource = { ...source, id: 'source-off' };
    specPostProcess.identityEnabledFor.mockImplementation((s) => s.id !== 'source-off');
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([
      recordOf('current', { modelContract: CONTRACT }),
      recordOf('stale', { modelContract: 'old' }),
      recordOf('no-title', { originalName: undefined }),
      { ...recordOf('off'), source: offSource } as unknown as ProductSourceRecord,
    ]);

    const summary = await run();

    expect(summary).toMatchObject({ read: 4, current: 1, noTitle: 1, identityOff: 1, asked: 1, written: 1 });
    expect(sourceRecordRepo.setModel).toHaveBeenCalledTimes(1);
    expect(sourceRecordRepo.setModel).toHaveBeenCalledWith('stale', expect.anything());
  });

  // A failed refresh keeps the stored model under its old contract.
  it('counts a call that left the model under the old contract as failed, and writes nothing for it', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([recordOf('r1', { modelContract: 'old' })]);
    specPostProcess.extractIdentity.mockImplementationOnce(async ({ scrapedProduct }) => scrapedProduct);

    const summary = await run();

    expect(summary).toMatchObject({ asked: 1, written: 0, failed: 1, productsMerged: 0 });
    expect(sourceRecordRepo.setModel).not.toHaveBeenCalled();
    expect(mergeService.mergeSources).not.toHaveBeenCalled();
  });

  it('only counts in a dry run', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([recordOf('r1'), recordOf('r2')]);

    const summary = await run({ dryRun: true });

    expect(listingColumns.fill).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(summary).toMatchObject({ read: 2, asked: 2, written: 0 });
    expect(specPostProcess.extractIdentity).not.toHaveBeenCalled();
    expect(sourceRecordRepo.setModel).not.toHaveBeenCalled();
  });

  it('stops at the limit and says more are left', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([
      recordOf('r1'),
      recordOf('r2'),
      recordOf('r3'),
    ]);

    const summary = await run({ limit: 2 });

    expect(summary).toMatchObject({ asked: 2, written: 2, more: true });
    expect(sourceRecordRepo.setModel).toHaveBeenCalledTimes(2);
  });
});
