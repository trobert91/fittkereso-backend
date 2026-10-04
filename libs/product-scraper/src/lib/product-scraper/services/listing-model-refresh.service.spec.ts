import type { ProductSourceRecord, ScrapedProduct } from '@fittkereso-backend/database';
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
  let service: ListingModelRefreshService;

  const source = { id: 'source-1', name: 'akosbike-arukereso', config: {} };
  const recordOf = (id: string, listing: Partial<ScrapedProduct> = {}): ProductSourceRecord =>
    ({
      id,
      url: `https://akosbike.hu/${id}`,
      source,
      scrapedProduct: {
        brand: 'Cube',
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
      normalizedModelOf: jest.fn((listing: ScrapedProduct) => `key:${listing.model}`),
    };
    service = new ListingModelRefreshService(
      sourceRecordRepo as never,
      specPostProcess as never,
      matchQuery as never,
    );
  });

  it('asks each due listing as its own last import, and writes only its model, display name, contract and key', async () => {
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
      displayName: 'Cube Kathmandu Hybrid ONE 800',
      contract: CONTRACT,
      key: 'key:Kathmandu Hybrid ONE 800',
    });
    expect(summary).toMatchObject({ read: 1, asked: 1, written: 1, failed: 0, more: false });
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

    expect(summary).toMatchObject({ asked: 1, written: 0, failed: 1 });
    expect(sourceRecordRepo.setModel).not.toHaveBeenCalled();
  });

  it('only counts in a dry run', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([recordOf('r1'), recordOf('r2')]);

    const summary = await run({ dryRun: true });

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
