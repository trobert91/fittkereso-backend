import { ProductDuplicateScanService } from './product-duplicate-scan.service';
import { SCAN_BUDGET_MS, STALE_PAIR_GRACE_MS } from './product-identity.constants';

describe('ProductDuplicateScanService', () => {
  let productRepo: { find: jest.Mock };
  let pairRepo: { deleteStaleOpenPairs: jest.Mock };
  let duplicateService: { detect: jest.Mock };
  let service: ProductDuplicateScanService;

  const page = (...ids: string[]) => ids.map((id) => ({ id }));

  beforeEach(() => {
    productRepo = { find: jest.fn().mockResolvedValue([]) };
    pairRepo = { deleteStaleOpenPairs: jest.fn().mockResolvedValue(3) };
    duplicateService = { detect: jest.fn().mockResolvedValue(1) };
    service = new ProductDuplicateScanService(
      productRepo as never,
      pairRepo as never,
      duplicateService as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('run', () => {
    it('detects every product page by page, then removes pairs it did not re-find', async () => {
      productRepo.find
        .mockResolvedValueOnce(page('p1', 'p2'))
        .mockResolvedValueOnce(page('p3'))
        .mockResolvedValueOnce([]);

      const summary = await service.run();

      expect(duplicateService.detect.mock.calls).toEqual([
        ['p1', 'scan'],
        ['p2', 'scan'],
        ['p3', 'scan'],
      ]);
      expect(summary).toMatchObject({
        processed: 3,
        pairsWritten: 3,
        staleRemoved: 3,
        budgetHit: false,
      });
    });

    it('cuts the stale-pair deadline back from the scan start, to absorb clock skew', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-16T03:00:00Z'));
      productRepo.find.mockResolvedValueOnce(page('p1')).mockResolvedValueOnce([]);

      await service.run();

      expect(pairRepo.deleteStaleOpenPairs).toHaveBeenCalledWith(
        new Date(Date.parse('2026-09-16T03:00:00Z') - STALE_PAIR_GRACE_MS),
      );
    });

    it('keeps going when one product fails', async () => {
      productRepo.find.mockResolvedValueOnce(page('p1', 'p2')).mockResolvedValueOnce([]);
      duplicateService.detect
        .mockRejectedValueOnce(new Error('recall exploded'))
        .mockResolvedValueOnce(2);

      const summary = await service.run();

      expect(summary).toMatchObject({ processed: 2, pairsWritten: 2 });
    });

    it('stops at the time budget and leaves stale pairs alone', async () => {
      jest.useFakeTimers();
      productRepo.find.mockResolvedValue(page('p1', 'p2'));
      duplicateService.detect.mockImplementation(async () => {
        jest.advanceTimersByTime(SCAN_BUDGET_MS + 1);
        return 0;
      });

      const summary = await service.run();

      expect(summary).toMatchObject({ processed: 1, budgetHit: true, staleRemoved: 0 });
      expect(pairRepo.deleteStaleOpenPairs).not.toHaveBeenCalled();
    });
  });

  describe('start', () => {
    it('refuses a second scan while one is running, and allows the next one after it ends', async () => {
      let finish: () => void = () => undefined;
      const runSpy = jest
        .spyOn(service, 'run')
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = () =>
                resolve({
                  processed: 0,
                  pairsWritten: 0,
                  staleRemoved: 0,
                  durationMs: 0,
                  budgetHit: false,
                });
            }),
        );

      expect(service.start()).toBe(true);
      expect(service.start()).toBe(false);
      expect(service.isRunning()).toBe(true);
      expect(runSpy).toHaveBeenCalledTimes(1);

      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(service.isRunning()).toBe(false);
      expect(service.start()).toBe(true);
    });

    it('clears the running flag when the scan throws', async () => {
      jest.spyOn(service, 'run').mockRejectedValue(new Error('boom'));

      expect(service.start()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(service.isRunning()).toBe(false);
    });
  });
});
