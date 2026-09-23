import { Injectable } from '@nestjs/common';
import {
  OfferRepository,
  ProductSource,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ScrapedListProduct,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { normalizeUrl } from '@fittkereso-backend/utils';

/**
 * The fields required by default before a list card may stand in for a detail
 * scrape. Overridable via `import.listRefreshRequiredFields`.
 */
export const DEFAULT_LIST_REFRESH_REQUIRED_FIELDS = [
  'url',
  'price',
  'availability',
];

export type ListItemOutcome =
  /** Refreshed in place — no detail fetch spent. */
  | 'refreshed'
  /** Known listing, but the card was too thin; detail scrape needed. */
  | 'incomplete'
  /** Not seen before; only a detail page has its specs, brand and model. */
  | 'unknown'
  /** Known listing with no offer row to refresh yet. */
  | 'no_offer';

/**
 * Decides, per list card, whether an already-known listing can be refreshed
 * from the card alone — and does it when so.
 *
 * This is where the cost saving actually happens: every card that satisfies the
 * minimum set is a paid detail fetch not spent. Never touches specs, images or
 * product identity; those change rarely, prices change constantly.
 */
@Injectable()
export class ListProductRefreshService {
  private readonly logger = new CustomLogger(ListProductRefreshService.name);

  constructor(
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly offerRepo: OfferRepository,
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  get requiredFields(): string[] {
    return (
      this.dynamicConfig.import?.listRefreshRequiredFields ??
      DEFAULT_LIST_REFRESH_REQUIRED_FIELDS
    );
  }

  /** True when the card carries every field the minimum set asks for. */
  satisfiesMinimumSet(item: ScrapedListProduct): boolean {
    return this.requiredFields.every((field) => {
      const value = (item as unknown as Record<string, unknown>)[field];
      return value !== undefined && value !== null && value !== '';
    });
  }

  /**
   * Try to refresh this card's listing without a detail scrape.
   *
   * Returns what happened so the caller can decide whether to enqueue a detail
   * task and can report the split — which is the number that says whether the
   * saving is real for this shop.
   */
  async tryRefresh(
    source: ProductSource,
    item: ScrapedListProduct,
  ): Promise<ListItemOutcome> {
    const record = await this.sourceRecordRepo.findBySourceAndUrl(
      source.id,
      normalizeUrl(item.url),
    );

    // Never seen by THIS source. Even if another source knows the URL, this
    // one still needs its own record, which only a detail scrape produces.
    if (!record) return 'unknown';

    if (!this.satisfiesMinimumSet(item)) return 'incomplete';

    const offer = this.pickOffer(record, item);
    if (!offer) return 'no_offer';

    await this.offerRepo.refreshFromListProduct(offer.id, {
      price: item.price,
      priceWithoutDiscount: item.priceWithoutDiscount,
      currency: item.currency,
      availability: item.availability,
    });

    return 'refreshed';
  }

  /**
   * Which of the record's offers this card refers to.
   *
   * Prefers an externalId match; falls back to the sole offer when the record
   * has exactly one. A record with several offers and no externalId on the card
   * is ambiguous, and guessing would write one variant's price onto another —
   * so it yields nothing and the caller falls back to a detail scrape.
   */
  private pickOffer(record: ProductSourceRecord, item: ScrapedListProduct) {
    const offers = record.offers ?? [];
    if (offers.length === 0) return undefined;

    if (item.externalId) {
      const byExternalId = offers.find(
        (offer) => offer.externalId === item.externalId,
      );
      if (byExternalId) return byExternalId;
    }

    if (offers.length === 1) return offers[0];

    this.logger.debug(
      'List card matched a record with several offers and no usable externalId',
      { url: item.url, offers: offers.length },
    );
    return undefined;
  }
}
