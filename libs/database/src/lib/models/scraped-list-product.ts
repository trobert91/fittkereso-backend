import { OfferAvailability } from '../postgres/types/offer-availability';

/**
 * One product as read off a category LIST page, without opening its detail page.
 *
 * The cheap half of the scraping import. For a listing this source has already
 * imported, a list card that carries everything in the configured minimum set
 * is enough to refresh the offer outright — which is the whole cost saving,
 * since every avoided detail scrape is a paid fetch not spent. Anything short
 * of that, or not yet known at all, gets a detail-page task instead.
 *
 * Deliberately carries NO specs. The two cases are exhaustive and neither wants
 * them: a known listing is only having price and availability refreshed and its
 * specs must not be touched, and an unknown one is getting a detail scrape
 * anyway, which produces the real spec set. Carrying specs here would create a
 * second, thinner source of truth for them.
 */
export interface ScrapedListProduct {
  /** Required — without it the item cannot be matched to a stored listing. */
  url: string;
  /** Source-native id, when the card exposes one. */
  externalId?: string;
  name?: string;
  price?: number;
  /** Pre-discount price — only when the card shows this item as discounted. */
  priceWithoutDiscount?: number;
  currency?: string;
  /**
   * Absent when the card does not expose stock at all (ebikeshop's cards, for
   * instance, carry prices but no stock). Absence must leave the stored value
   * untouched rather than overwrite it with `unknown` — a refresh may not
   * degrade data it cannot observe.
   */
  availability?: OfferAvailability;
}
