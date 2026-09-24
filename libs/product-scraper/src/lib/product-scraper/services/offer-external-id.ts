import type { ScrapedOffer } from '@fittkereso-backend/product';
import { normalizeUrl, slugFromUrl } from '@fittkereso-backend/utils';

/**
 * The `Offer.externalId` one scraped offer is stored under, before any
 * collision guard: its source-native id when it has one, otherwise the slug of
 * its own URL (or of the page's, when it has none).
 *
 * Shared because two places must agree on it exactly. The updater stores
 * offers under it; a feed run looks unchanged rows' offers up by it to refresh
 * them in place. A scraping source and an Árukereső source for one shop land
 * on the same string this way, which is how their offers converge on one row.
 */
export function offerExternalIdOf(
  scraped: Pick<ScrapedOffer, 'externalId' | 'url'>,
  pageUrl: string,
): { value: string | undefined; native: boolean } {
  const native = scraped.externalId?.trim() || undefined;
  const url = scraped.url ? normalizeUrl(scraped.url) : pageUrl;
  return { value: native ?? slugFromUrl(url), native: !!native };
}
