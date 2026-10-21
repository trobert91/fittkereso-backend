import { Injectable } from '@nestjs/common';
import { OfferClickRepository } from '@fittkereso-backend/database';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';

/** Hours a click keeps its visitor key: the website's 24-hour billing window. */
export const DEFAULT_VISITOR_KEY_RETENTION_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

export interface OfferClickRetentionResult {
  erased: number;
  cutoff: Date;
}

/**
 * Erases the pseudonymous visitor key of the website's clicks (OfferClick)
 * once it is older than `offers.clicks.visitorKeyRetentionHours`.
 *
 * The key exists for one thing: the website's billing check, which looks for
 * the same visitor's last billed click inside its window. Past the window
 * nothing needs it, so it is not kept (data minimisation). The rows stay — the
 * shops' statistics and bills are counted from them — but are tied to no one.
 */
@Injectable()
export class OfferClickRetentionService {
  constructor(
    private readonly clickRepo: OfferClickRepository,
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  get retentionHours(): number {
    return (
      this.dynamicConfig.offers?.clicks?.visitorKeyRetentionHours ??
      DEFAULT_VISITOR_KEY_RETENTION_HOURS
    );
  }

  async eraseExpiredVisitorKeys(
    now: Date = new Date(),
  ): Promise<OfferClickRetentionResult> {
    const cutoff = new Date(now.getTime() - this.retentionHours * MS_PER_HOUR);
    const erased = await this.clickRepo.eraseVisitorKeysBefore(cutoff);
    return { erased, cutoff };
  }
}
