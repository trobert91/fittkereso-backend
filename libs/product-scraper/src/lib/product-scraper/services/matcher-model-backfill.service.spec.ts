import type { ProductSourceRecord, ScrapedProduct } from '@fittkereso-backend/database';
import { MatcherModelBackfillService } from './matcher-model-backfill.service';

describe('MatcherModelBackfillService', () => {
  const CONTRACT = 'contract-now';
  let sourceRecordRepo: { findForMatcherModelBackfill: jest.Mock; setMatcherModel: jest.Mock };
  let specPostProcess: {
    matcherModelContractOf: jest.Mock;
    identityEnabledFor: jest.Mock;
    extractIdentity: jest.Mock;
  };
  let matchQuery: { matcherModelKeyOf: jest.Mock };
  let service: MatcherModelBackfillService;

  const source = { id: 'source-1', name: 'akosbike-arukereso', config: {} };
  const recordOf = (id: string, listing: Partial<ScrapedProduct> = {}): ProductSourceRecord =>
    ({
      id,
      url: `https://akosbike.hu/${id}`,
      source,
      scrapedProduct: {
        brand: 'Cube',
        model: 'Kathmandu Hybrid ONE 800',
        originalName: 'Cube Kathmandu Hybrid ONE 800 2025 54',
        category: { id: 'cat-1', slug: 'ebikes', name: 'E-bikes' },
        ...listing,
      },
    }) as unknown as ProductSourceRecord;

  const run = (overrides: Partial<Parameters<MatcherModelBackfillService['backfill']>[0]> = {}) =>
    service.backfill({ dryRun: false, limit: 100, concurrency: 2, ...overrides });

  beforeEach(() => {
    sourceRecordRepo = {
      findForMatcherModelBackfill: jest.fn().mockResolvedValue([]),
      setMatcherModel: jest.fn().mockResolvedValue(undefined),
    };
    specPostProcess = {
      matcherModelContractOf: jest.fn().mockReturnValue(CONTRACT),
      identityEnabledFor: jest.fn().mockReturnValue(true),
      extractIdentity: jest.fn(async ({ scrapedProduct }) => ({
        ...scrapedProduct,
        // Whatever the call says about the name, only the matcherModel is written.
        model: 'A Different Name',
        matcherModel: 'Kathmandu Hybrid ONE 800',
        matcherModelContract: CONTRACT,
      })),
    };
    matchQuery = { matcherModelKeyOf: jest.fn((_listing, text: string) => `key:${text}`) };
    service = new MatcherModelBackfillService(
      sourceRecordRepo as never,
      specPostProcess as never,
      matchQuery as never,
    );
  });

  it('asks each due listing as its own last import, and writes only its matcherModel, contract and key', async () => {
    const record = recordOf('r1');
    sourceRecordRepo.findForMatcherModelBackfill.mockResolvedValueOnce([record]);

    const summary = await run();

    expect(specPostProcess.extractIdentity).toHaveBeenCalledWith({
      context: { source, url: 'https://akosbike.hu/r1' },
      scrapedProduct: record.scrapedProduct,
      ownRecord: record,
    });
    expect(sourceRecordRepo.setMatcherModel).toHaveBeenCalledWith('r1', {
      matcherModel: 'Kathmandu Hybrid ONE 800',
      contract: CONTRACT,
      key: 'key:Kathmandu Hybrid ONE 800',
    });
    expect(summary).toMatchObject({ read: 1, asked: 1, written: 1, failed: 0, more: false });
  });

  it('skips listings keyed under the current contract, stored without a title, or of a source with the extraction off', async () => {
    const offSource = { ...source, id: 'source-off' };
    specPostProcess.identityEnabledFor.mockImplementation((s) => s.id !== 'source-off');
    sourceRecordRepo.findForMatcherModelBackfill.mockResolvedValueOnce([
      recordOf('current', { matcherModel: 'Kathmandu Hybrid ONE 800', matcherModelContract: CONTRACT }),
      recordOf('stale', { matcherModel: 'Kathmandu Hybrid ONE 800', matcherModelContract: 'old' }),
      recordOf('no-title', { originalName: undefined }),
      { ...recordOf('off'), source: offSource } as unknown as ProductSourceRecord,
    ]);

    const summary = await run();

    expect(summary).toMatchObject({ read: 4, current: 1, noTitle: 1, identityOff: 1, asked: 1, written: 1 });
    expect(sourceRecordRepo.setMatcherModel).toHaveBeenCalledTimes(1);
    expect(sourceRecordRepo.setMatcherModel).toHaveBeenCalledWith('stale', expect.anything());
  });

  it('counts a call that gave no matcherModel as failed, and writes nothing for it', async () => {
    sourceRecordRepo.findForMatcherModelBackfill.mockResolvedValueOnce([recordOf('r1')]);
    specPostProcess.extractIdentity.mockImplementationOnce(async ({ scrapedProduct }) => scrapedProduct);

    const summary = await run();

    expect(summary).toMatchObject({ asked: 1, written: 0, failed: 1 });
    expect(sourceRecordRepo.setMatcherModel).not.toHaveBeenCalled();
  });

  it('only counts in a dry run', async () => {
    sourceRecordRepo.findForMatcherModelBackfill.mockResolvedValueOnce([recordOf('r1'), recordOf('r2')]);

    const summary = await run({ dryRun: true });

    expect(summary).toMatchObject({ read: 2, asked: 2, written: 0 });
    expect(specPostProcess.extractIdentity).not.toHaveBeenCalled();
    expect(sourceRecordRepo.setMatcherModel).not.toHaveBeenCalled();
  });

  it('stops at the limit and says more are left', async () => {
    sourceRecordRepo.findForMatcherModelBackfill.mockResolvedValueOnce([
      recordOf('r1'),
      recordOf('r2'),
      recordOf('r3'),
    ]);

    const summary = await run({ limit: 2 });

    expect(summary).toMatchObject({ asked: 2, written: 2, more: true });
    expect(sourceRecordRepo.setMatcherModel).toHaveBeenCalledTimes(2);
  });
});
