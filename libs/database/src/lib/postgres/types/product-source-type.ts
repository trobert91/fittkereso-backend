/**
 * What kind of import a ProductSource runs — and therefore which shape its
 * `config` jsonb takes and which importer service handles it.
 *
 * A plain TS union over a `text` column rather than a pg enum, matching
 * ProductSourceActionType: adding a type needs no ALTER TYPE, and the value
 * set stays readable in one place.
 *
 * Fixed at creation. The config format is type-bound, so reinterpreting an
 * existing source's config under a different type would either fail
 * validation or, worse, silently read the wrong keys —
 * ProductSourceUpdateService rejects any attempt to change it.
 *
 * 'arukereso' and 'googleshop' are both feeds, with one config format and one
 * importer: the type says which feed a shop publishes, so a seller can have
 * one of each. Only Google's TSV format is read — an RSS/XML Google feed
 * (`<item>`, `g:` tags) would parse no item.
 */
export const PRODUCT_SOURCE_TYPES = ['scraping', 'arukereso', 'googleshop'] as const;

export type ProductSourceType = (typeof PRODUCT_SOURCE_TYPES)[number];

export const isProductSourceType = (value: unknown): value is ProductSourceType =>
  typeof value === 'string' &&
  (PRODUCT_SOURCE_TYPES as readonly string[]).includes(value);

/**
 * Whether the source imports a whole catalog feed in one pass, as opposed to
 * crawling pages. Only a feed run knows when it has seen everything, which is
 * what `hasAllProducts` relies on.
 */
export const isFeedSourceType = (type: ProductSourceType): boolean =>
  type === 'arukereso' || type === 'googleshop';
