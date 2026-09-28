import { normalizeUrl, slugFromUrl } from './url-utils';

/** The fields of a scraped offer its externalId is derived from. */
export interface OfferIdentityFields {
  externalId?: string;
  url?: string | null;
}

/**
 * The `Offer.externalId` one scraped offer is stored under, before any
 * collision guard: its source-native id when it has one, otherwise the slug of
 * its own URL (or of the page's, when it has none).
 *
 * Shared because several places must agree on it exactly. The updater stores
 * offers under it; a feed run looks unchanged rows' offers up by it to refresh
 * them in place. A scraping source and an Árukereső source for one shop land
 * on the same string this way, which is how their offers converge on one row.
 */
export function offerExternalIdOf(
  scraped: OfferIdentityFields,
  pageUrl: string,
): { value: string | undefined; native: boolean } {
  const native = scraped.externalId?.trim() || undefined;
  const url = scraped.url ? normalizeUrl(scraped.url) : pageUrl;
  return { value: native ?? slugFromUrl(url), native: !!native };
}

/**
 * The key of a listing's ProductSourceRecord within its source: its
 * source-native id when it has one, otherwise the slug of its page URL (the
 * URL itself where the path has no slug). Always set, so every record of a
 * source is found by it, and a URL change moves the record instead of adding
 * one.
 *
 * The native id must name exactly one listing (a detail page, or a feed row).
 * A size group's shared id belongs in siblingExternalIds.
 */
export function listingExternalIdOf(
  scraped: { externalId?: string | number | null },
  pageUrl: string,
): string {
  const native = scraped.externalId == null ? '' : String(scraped.externalId).trim();
  const url = normalizeUrl(pageUrl);
  return native || slugFromUrl(url) || url;
}

/**
 * The externalId a stored offer entry (ProductSourceRecord.scrapedProduct.offers)
 * joins its offer by: the one it was stored under, or none when its id
 * collided on its page. Entries stored before `resolvedExternalId` existed
 * derive it the way it was derived then.
 */
export function storedOfferExternalId(
  record: { url?: string | null },
  entry: OfferIdentityFields & { resolvedExternalId?: string | null },
): string | undefined {
  if (entry.resolvedExternalId !== undefined) {
    return entry.resolvedExternalId ?? undefined;
  }
  return offerExternalIdOf(entry, record.url ?? '').value;
}
