/**
 * How a ProductSource's pages and feeds reach us.
 *
 * - 'proxied': through the paid scraping API (Zyte today). The value names no
 *   vendor, so changing vendors changes no stored row.
 * - 'direct': our own HTTP client calls the shop. Free, so it is for shops
 *   that agreed to be read — and for any document over the scraping API's
 *   10 MB limit, which it would silently truncate.
 *
 * A plain TS union over a `text` column, like ProductSourceType.
 */
export const PRODUCT_SOURCE_FETCH_MODES = ['proxied', 'direct'] as const;

export type ProductSourceFetchMode = (typeof PRODUCT_SOURCE_FETCH_MODES)[number];

/** What every source gets unless someone chose otherwise: a shop is only called directly on purpose. */
export const DEFAULT_PRODUCT_SOURCE_FETCH_MODE: ProductSourceFetchMode = 'proxied';

export const isProductSourceFetchMode = (value: unknown): value is ProductSourceFetchMode =>
  typeof value === 'string' &&
  (PRODUCT_SOURCE_FETCH_MODES as readonly string[]).includes(value);
