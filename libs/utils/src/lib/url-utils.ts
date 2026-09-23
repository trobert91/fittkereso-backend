export const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '');

export const domainFromUrl = (url: string): string => {
  const urlObject = new URL(url);
  return urlObject.hostname.replace('www.', '');
};

const PLATFORM_BASE_URLS: Record<string, string> = {
  reddit: 'https://reddit.com',
  youtube: 'https://youtube.com',
};

export const resolveExternalUrl = (
  relativeUrl: string | null | undefined,
  platform: string | null | undefined,
): string | null => {
  if (!relativeUrl) return null;
  if (relativeUrl.startsWith('http')) return relativeUrl;
  const base = platform ? (PLATFORM_BASE_URLS[platform] ?? null) : null;
  return base ? `${base}${relativeUrl}` : relativeUrl;
};

/**
 * The identity form of a product URL: query string and fragment dropped,
 * trailing slashes trimmed.
 *
 * `normalizeUrl` above deliberately does NOT do this — some configured URLs
 * carry meaningful query strings (speedbike's `index.php?route=filter&…`
 * category pages), so canonicalization is applied at product-identity call
 * sites only.
 *
 * It is the Árukereső feed that forces the issue: it ships `product_url`
 * already UTM-tagged (`?utm_source=arukereso&utm_medium=cpp&aku=<hash>`), and
 * `aku` is not even stable between feed generations — so without this, a feed
 * row and the scraped page for the same product are two different strings.
 */
export const canonicalizeProductUrl = (url: string): string => {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.search = '';
    parsed.hash = '';
    return normalizeUrl(parsed.toString());
  } catch {
    // Relative or otherwise unparseable — strip by hand rather than reject.
    return normalizeUrl(trimmed.split('#')[0].split('?')[0]);
  }
};

/**
 * The whole path of the canonical URL, with leading and trailing slashes
 * removed — the `Offer.externalId` fallback for a source that emits no
 * source-native id.
 *
 * The WHOLE path, not the last segment: keeping the internal slashes is what
 * stops `/kerekpar/ktm-macina` and `/akcio/ktm-macina` — the same product
 * listed in two sections, or a used listing beside a new one — collapsing onto
 * one identity.
 *
 * Returns undefined rather than a degenerate value, because `Offer` is
 * `@Unique([seller, externalId])`: one empty string would collapse EVERY such
 * offer of that seller into a single row. A purely numeric path is refused for
 * the milder version of the same reason — it is indistinguishable from a real
 * sku, so a slug-derived `12345` could silently adopt another source's listing.
 */
export const slugFromUrl = (url: string): string | undefined => {
  const canonical = canonicalizeProductUrl(url);

  let path: string;
  try {
    path = new URL(canonical).pathname;
  } catch {
    path = canonical;
  }

  const slug = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');

  if (!slug) return undefined;
  if (/^[\d/]+$/.test(slug)) return undefined;

  return slug;
};
