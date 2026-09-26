import { Injectable } from '@nestjs/common';
import { DynamicConfigService } from './dynamic-config.service';

/**
 * Offers synced within this many days are current: visible, and allowed to set
 * their product's price. Older ones are inactive.
 */
export const DEFAULT_OFFER_FRESHNESS_DAYS = 3;

/** Offers not synced for this many days are hard-deleted. */
export const DEFAULT_OFFER_DELETE_AFTER_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The two cutoffs that make Offer.lastSynced the whole delisting mechanism.
 *
 * Every import run stamps lastSynced on the offers it confirms. Nothing marks
 * an offer as gone: a source that stops seeing a product simply stops stamping
 * it, so the offer falls out of `visibleCutoff` first — the nightly sweep then
 * reprices its product — and past `deleteCutoff` later.
 *
 * Lives here rather than in libs/product because the product search (in
 * libs/search, which libs/product imports) needs the same cutoff.
 *
 * Both cutoffs come from dynamic config (`offers.json`) so they can be widened
 * without a code change — useful precisely when something has gone wrong and a
 * catalog is ageing out that shouldn't be.
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
   * Whether the sweep may actually delete. Defaults to FALSE; `offers.json`
   * turns it on.
   *
   * The sweep reads "not stamped recently" as "gone", which is only sound while
   * imports are running. It keeps the offers of a seller nothing has confirmed
   * recently (StaleOfferSweepService), and this stays as the kill switch.
   */
  get deletionEnabled(): boolean {
    return this.dynamicConfig.offers?.deletionEnabled ?? false;
  }

  /**
   * Whether a complete run of a source listing the whole catalog removes the
   * offers it did not see (CompleteSourceRemovalService). Defaults to TRUE:
   * only a complete, uncapped, unfiltered run removes anything, and a share
   * guard stops a truncated feed.
   */
  get completeSourceRemovalEnabled(): boolean {
    return this.dynamicConfig.offers?.completeSourceRemovalEnabled ?? true;
  }

  /** Offers with `lastSynced >= this` are current; older ones are inactive. */
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
