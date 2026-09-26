import { CustomLogger } from '@fittkereso-backend/logger';
import { StaleProductRepriceService } from './stale-product-reprice.service';

describe('StaleProductRepriceService', () => {
  const VISIBLE_CUTOFF = new Date('2026-09-23T06:30:00Z');

  let service: StaleProductRepriceService;
  let offerRepo: { findModelIdsToReprice: jest.Mock };
  let productRepo: { findOne: jest.Mock; save: jest.Mock };
  let mergeService: { recomputePrice: jest.Mock };
  let locks: { withLocks: jest.Mock };
  let error: jest.SpyInstance;

  beforeEach(() => {
    offerRepo = { findModelIdsToReprice: jest.fn().mockResolvedValue(['model-1', 'model-2']) };
    productRepo = {
      findOne: jest.fn().mockImplementation(({ where }) => Promise.resolve({ id: where.id })),
      save: jest.fn().mockResolvedValue(undefined),
    };
    mergeService = {
      recomputePrice: jest.fn().mockImplementation(async (model) => {
        model.price = null;
        return model;
      }),
    };
    locks = {
      withLocks: jest.fn(async (_keys: unknown, work: () => Promise<unknown>) => work()),
    };
    error = jest.spyOn(CustomLogger.prototype, 'error').mockImplementation(() => undefined);

    service = new StaleProductRepriceService(
      offerRepo as never,
      productRepo as never,
      { visibleCutoff: () => VISIBLE_CUTOFF } as never,
      mergeService as never,
      locks as never,
    );
  });

  afterEach(() => {
    error.mockRestore();
  });

  it('asks for the products whose price differs, by the visible cutoff', async () => {
    await service.reprice();

    expect(offerRepo.findModelIdsToReprice).toHaveBeenCalledWith(VISIBLE_CUTOFF);
  });

  it('reloads, recomputes and saves each product under its own lock', async () => {
    const repriced = await service.reprice();

    expect(repriced).toBe(2);
    expect(locks.withLocks.mock.calls.map(([keys]) => keys)).toEqual([
      [{ namespace: 1, id: 'model-1' }],
      [{ namespace: 1, id: 'model-2' }],
    ]);
    expect(productRepo.findOne).toHaveBeenCalledWith({ where: { id: 'model-1' } });
    expect(productRepo.save).toHaveBeenCalledWith({ id: 'model-1', price: null });
    expect(mergeService.recomputePrice.mock.invocationCallOrder[0]).toBeLessThan(
      productRepo.save.mock.invocationCallOrder[0],
    );
  });

  it('does not count a product that no longer exists', async () => {
    productRepo.findOne.mockResolvedValueOnce(null);

    const repriced = await service.reprice();

    expect(repriced).toBe(1);
    expect(productRepo.save).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one product fails', async () => {
    mergeService.recomputePrice.mockRejectedValueOnce(new Error('boom'));

    const repriced = await service.reprice();

    expect(repriced).toBe(1);
    expect(productRepo.save).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('does nothing when every price matches', async () => {
    offerRepo.findModelIdsToReprice.mockResolvedValue([]);

    expect(await service.reprice()).toBe(0);
    expect(locks.withLocks).not.toHaveBeenCalled();
  });
});
