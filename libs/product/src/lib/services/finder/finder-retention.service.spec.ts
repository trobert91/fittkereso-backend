import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import {
  DEFAULT_FINDER_RETENTION_DAYS,
  FinderRetentionService,
} from './finder-retention.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-22T12:00:00Z');

describe('FinderRetentionService', () => {
  let visitorRepo: { deleteNotSeenSince: jest.Mock };

  const serviceWith = (finder?: DynamicConfigService['finder']) =>
    new FinderRetentionService(
      visitorRepo as never,
      { finder } as DynamicConfigService,
    );

  beforeEach(() => {
    visitorRepo = { deleteNotSeenSince: jest.fn().mockResolvedValue(2) };
  });

  it('deletes visitors not seen for 6 months by default', async () => {
    const result = await serviceWith(undefined).deleteExpired(NOW);

    expect(DEFAULT_FINDER_RETENTION_DAYS).toBe(183);
    expect(visitorRepo.deleteNotSeenSince).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 183 * DAY),
    );
    expect(result).toEqual({ deleted: 2, cutoff: new Date(NOW.getTime() - 183 * DAY) });
  });

  it('takes the retention finder.json sets', async () => {
    await serviceWith({ retentionDays: 30 }).deleteExpired(NOW);

    expect(visitorRepo.deleteNotSeenSince).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 30 * DAY),
    );
  });
});
