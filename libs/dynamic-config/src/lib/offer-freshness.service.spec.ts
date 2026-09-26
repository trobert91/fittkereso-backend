import {
  DEFAULT_OFFER_DELETE_AFTER_DAYS,
  DEFAULT_OFFER_FRESHNESS_DAYS,
  OfferFreshnessService,
} from './offer-freshness.service';
import { DynamicConfigService } from './dynamic-config.service';
import { DynamicConfigData } from './models/dynamic-config-data.interface';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-26T06:30:00Z');

const serviceWith = (offers?: DynamicConfigData['offers']) =>
  new OfferFreshnessService({ offers } as DynamicConfigService);

describe('OfferFreshnessService', () => {
  it('defaults to 3 days fresh, 14 days to deletion, deletion off', () => {
    const service = serviceWith(undefined);

    expect(DEFAULT_OFFER_FRESHNESS_DAYS).toBe(3);
    expect(DEFAULT_OFFER_DELETE_AFTER_DAYS).toBe(14);
    expect(service.freshnessDays).toBe(3);
    expect(service.deleteAfterDays).toBe(14);
    expect(service.deletionEnabled).toBe(false);
    expect(service.completeSourceRemovalEnabled).toBe(true);
  });

  it('takes the values offers.json sets', () => {
    const service = serviceWith({
      freshnessDays: 5,
      deleteAfterDays: 20,
      deletionEnabled: true,
    });

    expect(service.visibleCutoff(NOW)).toEqual(new Date(NOW.getTime() - 5 * DAY));
    expect(service.deleteCutoff(NOW)).toEqual(new Date(NOW.getTime() - 20 * DAY));
    expect(service.deletionEnabled).toBe(true);
  });

  it('never puts the delete cutoff at or after the visible one', () => {
    const service = serviceWith({ freshnessDays: 7, deleteAfterDays: 5 });

    expect(service.deleteCutoff(NOW)).toEqual(new Date(NOW.getTime() - 8 * DAY));
    expect(service.deleteCutoff(NOW).getTime()).toBeLessThan(
      service.visibleCutoff(NOW).getTime(),
    );
  });
});
