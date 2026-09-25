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
