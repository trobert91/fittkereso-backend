import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import {
  DEFAULT_VISITOR_KEY_RETENTION_HOURS,
  OfferClickRetentionService,
} from './offer-click-retention.service';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-21T12:00:00Z');

describe('OfferClickRetentionService', () => {
  let clickRepo: { eraseVisitorKeysBefore: jest.Mock };

  const serviceWith = (offers?: DynamicConfigService['offers']) =>
    new OfferClickRetentionService(
      clickRepo as never,
      { offers } as DynamicConfigService,
    );

  beforeEach(() => {
    clickRepo = { eraseVisitorKeysBefore: jest.fn().mockResolvedValue(3) };
  });

  it('erases keys older than the 24-hour billing window by default', async () => {
    const result = await serviceWith(undefined).eraseExpiredVisitorKeys(NOW);

    expect(DEFAULT_VISITOR_KEY_RETENTION_HOURS).toBe(24);
    expect(clickRepo.eraseVisitorKeysBefore).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 24 * HOUR),
    );
    expect(result).toEqual({ erased: 3, cutoff: new Date(NOW.getTime() - 24 * HOUR) });
  });

  it('takes the retention offers.json sets', async () => {
    await serviceWith({ clicks: { visitorKeyRetentionHours: 48 } }).eraseExpiredVisitorKeys(NOW);

    expect(clickRepo.eraseVisitorKeysBefore).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 48 * HOUR),
    );
  });
});
