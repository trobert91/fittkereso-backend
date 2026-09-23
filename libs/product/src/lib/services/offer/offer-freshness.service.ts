import { Injectable } from '@nestjs/common';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';

/** Offers synced within this many days are publicly visible. */
export const DEFAULT_OFFER_FRESHNESS_DAYS = 7;

/** Offers not synced for this many days are hard-deleted. */
export const DEFAULT_OFFER_DELETE_AFTER_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The two cutoffs that make Offer.lastSynced the whole delisting mechanism.
 *
 * Every import run stamps lastSynced on the offers it confirms. Nothing marks
 * an offer as gone: a source that stops seeing a product simply stops stamping
 * it, so the offer falls out of `visibleCutoff` first and past `deleteCutoff`
 * later. That is why there are no miss counters and no gone-sweep.
 *
 * Both cutoffs come from dynamic config so they can be widened without a
 * deploy — useful precisely when something has gone wrong and a catalog is
 * ageing out that shouldn't be.
 */
@Injectable()
export class OfferFreshnessService {
  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  get freshnessDays(): number {
    return (
      this.dynamicConfig.offers?.freshnessDays ?? DEFAULT_OFFER_FRESHNESS_DAYS
    );
  }

  get deleteAfterDays(): number {
    return (
      this.dynamicConfig.offers?.deleteAfterDays ??
      DEFAULT_OFFER_DELETE_AFTER_DAYS
    );
  }

  /**
   * Whether the sweep may actually delete. Defaults to FALSE.
   *
   * Off by default because the sweep reads "not stamped recently" as "gone",
   * which is only sound while imports are running. On an estate where nothing
   * imports, every offer ages out and is destroyed on a schedule.
   */
  get deletionEnabled(): boolean {
    return this.dynamicConfig.offers?.deletionEnabled ?? false;
  }

  /** Offers with `lastSynced >= this` are publicly visible. */
  visibleCutoff(now: Date = new Date()): Date {
    return new Date(now.getTime() - this.freshnessDays * MS_PER_DAY);
  }

  /**
   * Offers with `lastSynced < this` are deleted.
   *
   * Never returns a cutoff at or newer than `visibleCutoff` — a misconfiguration
   * putting deleteAfterDays at or below freshnessDays would otherwise delete
   * offers the moment they stopped being visible, removing the grace period
   * entirely. Clamped rather than thrown so a bad edit degrades to the default
   * behaviour instead of stopping the sweep.
   */
  deleteCutoff(now: Date = new Date()): Date {
    const days = Math.max(this.deleteAfterDays, this.freshnessDays + 1);
    return new Date(now.getTime() - days * MS_PER_DAY);
  }
}
