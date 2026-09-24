import { SourceSpecConfig } from './product-category-config';
import { CategoryLookupRule, ScrapeOperation } from './scrape-operation';


export interface ProductSourceCategoryConfig {
  enabled: boolean;
  sourceTitle?: string;
}

export interface ProductSourcePaginationConfig {
  /** Supports {{baseUrl}}, {{startUrl}} and {{page}}. */
  urlTemplate: string;
  /** Pipeline run against page 1 yielding the total page count. */
  pageCount: ScrapeOperation[];
}

export interface ProductSourceListPageConfig {
  categoryName: ScrapeOperation[];
  /**
   * How to enumerate the remaining pages of a listing. Omit for a listing that
   * fits on one page.
   *
   * Evaluated ONCE, by the importer, against page 1 — never by a list page
   * itself. A list-page task is a pure "parse the items here" unit with no
   * power to enqueue more pages, which is what makes the old re-emission bug
   * (every page re-emitting the whole range) structurally impossible rather
   * than merely guarded against.
   */
  pagination?: ProductSourcePaginationConfig;
  /** Pipeline yielding the array of product cards on the page. */
  items: ScrapeOperation[];
  itemMode: 'cheerio' | 'json';
  /** Run once per card; must terminate in an assembleListProduct op. */
  itemPipeline: ScrapeOperation[];
}

export interface ProductSourceOffersConfig {
  offerList: ScrapeOperation[];
  // 'cheerio': each list item is exposed as a single-element CheerioSelection
  // under vars[itemVar]. 'json': each item is exposed as vars[itemVar]
  // directly. See ForEachItemOp.
  itemMode: 'cheerio' | 'json';
  // Per-item pipeline, run once per entry in offerList; must terminate in an
  // assembleOffer op. Replaces the old flat price/etc. fields — see
  // AssembleOfferOp.
  itemPipeline: ScrapeOperation[];
}

export interface ProductSourceTranslationConfig {
  enabled: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  contextTemplate: string;
}

/**
 * Per-source switch for the LLM post-processing pass
 * (ProductSourcePostProcessService) — brand/model/specs/releaseYear
 * post-processing — which runs after the deterministic
 * SourceSpecMapping[]/scrape-op extraction. The category-level pieces the
 * LLM call needs (canonical schema, golden sample) live in category config,
 * not here — every source in a category shares them.
 *
 * Post-processing defaults to ON: a source with no `postProcess` block at all
 * (or `enabled` left unset) still runs it. Set `enabled: false` explicitly to
 * opt a source out — e.g. a source that turns out not to benefit from LLM
 * inference at all, where the extra cost is pure waste.
 */
export interface ProductSourcePostProcessConfig {
  enabled?: boolean;
  model?: string;
  /**
   * Reasoning toggle. Leave unset to use the service default (reasoning on at
   * `effort`). Set false for sources whose spec table is already normalized to
   * near-canonical labels (e.g. ebikeshop.hu, ambringa.hu) — those need
   * re-keying, not inference, so the reasoning tokens are likely waste. Sources
   * that publish only a free-text OEM component list (speedbike.hu,
   * tuttobici.hu, berguson.hu) do need it: fields like motorPosition,
   * seatpostType and the equipment booleans are only derivable by inference.
   */
  thinking?: boolean;
  /**
   * Provider-native reasoning effort, forwarded as-is (DeepSeek:
   * `reasoning_effort`). Note that supplying this implies thinking is enabled.
   */
  effort?: string;
  /**
   * Ceiling on generated tokens, guarding against a runaway reasoning trace.
   * Must stay well above the size of a fully-populated specs object for the
   * category, since a truncated response fails JSON parsing and silently
   * degrades the whole pass to deterministic-only.
   */
  maxTokens?: number;
  /**
   * Whether `detailPage.description` (when the source configures it) is
   * forwarded to the identity extraction. Defaults to false — that call reads
   * the name and identity fields from the title and the selected spec rows,
   * and a marketing blurb is unlikely to state those more precisely, so most
   * sources gain nothing from paying to send it. Enable per-source if a
   * listing's title omits a color/size/year that its description does state
   * clearly. (The name predates the identity extraction, and is kept so
   * stored configs keep validating.)
   */
  includeDescriptionInOfferIdentity?: boolean;
  /**
   * Whether `detailPage.description` (when the source configures it) is
   * forwarded to full spec unification (formerly the model-spec call). Defaults to true, matching this call's
   * original behavior before the toggle existed — every source that
   * configures a description has historically had it reach this call
   * unconditionally. Set false for a source whose description is pure sales
   * copy with no reliable spec content, to skip the extra input tokens.
   */
  includeDescriptionInModelSpecs?: boolean;
}

/**
 * What the LLM identity extraction reads from this source's listings.
 *
 * Per source rather than per category because it is about the SHOP's labels,
 * not the product's fields: every shop names its spec rows differently, but
 * one shop names them the same way on every listing. The fields the extraction
 * OUTPUTS stay category config (primarySpecs, matcherSpecs, offerLevelSpecs).
 */
export interface ProductSourceIdentityExtractionConfig {
  /**
   * Allowlist of spec-table row labels sent to the identity extraction — the
   * rows that carry a primary, matcher or offer-level spec (frame, motor,
   * battery, wheels, drivetrain, weight, year). Matched ignoring case, as
   * specMapping labels are, and ignoring stray whitespace — but not accents.
   *
   * Omit to send the whole table, which suits a shop whose table is already
   * short. A long free-text component list (speedbike's ~32 rows) is worth
   * narrowing: the other rows are brake pads and bar tape, which cost tokens
   * and cannot change a bike's identity. Full spec unification always gets
   * the whole table regardless.
   */
  specRows?: string[];
}

export interface ProductSourceDetailPageConfig {
  rawSpecs: ScrapeOperation[];
  /**
   * Free-text marketing/description copy from the listing (e.g. a
   * "Specifikáció"/"Részletek" prose block). Optional — absent/empty for
   * sources whose spec table is already fully structured. Lower-confidence
   * than rawSpecs by nature (prose, not a labeled table), but some sources
   * only state certain values here (see ProductSourcePostProcessService's
   * model-spec prompt, which treats it accordingly) — e.g. berguson.hu's
   * component list lives entirely in a description `<li>` list, not a
   * structured spec table.
   */
  description?: ScrapeOperation[];
  category: {
    breadcrumbOrSource: ScrapeOperation[];
    slugLookup: CategoryLookupRule[];
  };
  brand: ScrapeOperation[];
  model: ScrapeOperation[];
  aliases?: ScrapeOperation[];
  releaseYear?: ScrapeOperation[];
  // Source-native listing identifier (SKU/model code/slug), stable across URL
  // changes. Extracted once here (not only inside offers.itemPipeline) so
  // ProductSourceRecord.externalId can be populated independent of whether the
  // source's config populates `offers` at all. May be a group-level id shared
  // across variant siblings (e.g. ShopRenter's parent.sku) when the source
  // exposes one — see offerLinks below.
  externalId?: ScrapeOperation[];
  /**
   * The ids of this product's other sizes, as the shop itself declares them —
   * e.g. ebikeshop's frame-size variation list. Must yield ids in the same
   * space as `externalId`; may include this page's own. Becomes
   * ScrapedProduct.siblingExternalIds, which identity resolution looks up
   * within this source only, so every size a shop groups lands on one product.
   *
   * Configure it only from a list the SHOP declares. Groupings inferred from
   * shared images or article-number prefixes were measured to put different
   * bikes together.
   */
  siblingIds?: ScrapeOperation[];
  images: ScrapeOperation[];
  // Keyed by category slug — replaces the old per-category specMappings.json
  // file (which was keyed by source instead, now implicit in "which
  // ProductSource row this config belongs to").
  specMapping: Record<string, SourceSpecConfig>;
  offers?: ProductSourceOffersConfig;
  /**
   * Links to sibling detail pages for the SAME underlying product under a
   * different URL — e.g. frame-size/color variants each on their own page.
   * ProductDetailsPageScraperService fetches each of these synchronously
   * within the same scrape and folds their offers into one combined
   * ScrapedProduct before a single createOrUpdateProduct call — no separate
   * ProductImportTask is queued. Each fetched sibling still gets its own
   * ProductSourceRecord (one per URL) under the same resolved ProductModel.
   * Absent/empty for the overwhelming majority of sources.
   */
  offerLinks?: ScrapeOperation[];
  translation?: ProductSourceTranslationConfig;
  postProcess?: ProductSourcePostProcessConfig;
}

/**
 * Config for `type: 'scraping'` — page pipelines.
 *
 * `startUrls` replaces the old `fullSyncStartUrl` + `discovery` pair. Discovery
 * existed to *find* start URLs by matching category titles or brand names on a
 * hub page; naming them outright is both simpler and the only thing either live
 * source ever wanted. Neither had a `discovery` block, which is why full sync
 * silently did nothing.
 */
export interface ScrapingSourceConfig {
  baseUrl: string;
  /** Where each import run begins. At least one. */
  startUrls: string[];
  /**
   * How to expand a start URL into category URLs, for a hub page rather than a
   * listing. Optional — a start URL that is already a listing needs none.
   *
   * Walked ONCE per run, by the importer, for the same reason pagination is.
   */
  categoryLinks?: ScrapeOperation[];
  categories?: Record<string, ProductSourceCategoryConfig>;
  /**
   * Hard ceiling on how many items one run imports. Unset means no ceiling,
   * which is what a production source wants.
   *
   * **On a scraping source this caps items PER LIST PAGE**, not per run, and
   * that is a real limitation rather than a choice: each list page is its own
   * independently scheduled ProductImportTask, so there is no run-scoped counter for
   * them to share. To keep the cap meaningful for its actual purpose — a small
   * test set — setting it also makes the importer enumerate only the FIRST page
   * of each listing, since walking 42 pages to take 10 items is not what
   * anybody means by this.
   */
  maxItems?: number;
  /** Narrows a run to a subset of the catalogue. See ProductSourceFilterConfig. */
  filter?: ProductSourceFilterConfig;
  identityExtraction?: ProductSourceIdentityExtractionConfig;
  listPage: ProductSourceListPageConfig;
  detailPage: ProductSourceDetailPageConfig;
}

/**
 * One test against one field.
 *
 * Give exactly one operator. They are separate keys rather than an
 * `{ op, value }` pair because that is how the rest of this config reads
 * (`CategoryLookupCondition` does the same), and because it lets the schema
 * type each operator's value — `in` takes an array, `gte` takes a number.
 */
export interface ProductSourceFilterCondition {
  /**
   * Which field to test.
   *
   * For an `arukereso` source: ANY feed column, matched the same way `mapping`
   * matches — case-insensitively with `_`, `-` and spaces stripped — plus
   * `attribute:<name>` to test one of the feed's attribute pairs.
   *
   * For a `scraping` source: any field of the list card (`name`, `url`,
   * `price`, `externalId`, `availability`, …), because that is where filtering
   * is worth doing — a card rejected here is a paid detail fetch not spent.
   */
  field: string;
  equals?: string;
  notEquals?: string;
  contains?: string;
  notContains?: string;
  /** Regular expression, tested against the whole value. */
  matches?: string;
  in?: string[];
  notIn?: string[];
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  /** `true` matches only an absent/empty field; `false` only a present one. */
  isEmpty?: boolean;
}

/**
 * Narrows an import to a subset of what the source offers.
 *
 * Built for assembling a small, *representative* test set — "just the KTMs", or
 * "only bikes over 500k" — without hand-picking URLs or editing the source's
 * real config. It is a filter on what gets imported, not on what gets fetched:
 * the feed still downloads whole, and a list page is still parsed whole.
 *
 * Leaving it unset imports everything, which is what a production source wants.
 */
export interface ProductSourceFilterConfig {
  /** Whether every condition must hold, or just one. Default: `all`. */
  match?: 'all' | 'any';
  /** Default: false — string comparisons ignore case, which is almost always meant. */
  caseSensitive?: boolean;
  conditions: ProductSourceFilterCondition[];
}

/**
 * The complete set of things a feed field can be mapped onto.
 *
 * Closed, and asserted by the config schema, because a mapping key the importer
 * does not read would sit in the config looking effective while doing nothing —
 * a failure a config author cannot see from the outside. Adding a target means
 * adding it here and teaching the importer to read it, in that order.
 */
export const ARUKERESO_MAPPING_TARGETS = [
  /** Source-native id (sku, identifier). Falls back to the URL slug when absent. */
  'externalId',
  'brand',
  /**
   * The listing title. Becomes `originalName` verbatim, and `model` after the
   * post-process pass cleans it — a feed's `name` is the shop's full marketing
   * title, so the raw value is rarely a usable model name on its own.
   */
  'name',
  /** The product page URL — ProductSourceRecord identity and the offer's link. */
  'url',
  'price',
  'priceWithoutDiscount',
  'currency',
  /** Mapped onto OfferAvailability; anything unrecognised becomes `unknown`. */
  'availability',
  /** Primary image, or a list of them when the pipeline yields an array. */
  'imageUrl',
  'description',
  /** The raw category value that `category.labelFrom` and slugLookup consume. */
  'categoryLabel',
  'aliases',
  'releaseYear',
  /**
   * The offer's barcode (EAN/UPC/GTIN), as published. Validated and
   * normalized when stored on Offer.gtin — an invalid value is dropped there,
   * so mapping a field that is only sometimes a real barcode is safe.
   */
  'gtin',
  /**
   * The manufacturer's article number for this size. Only map a field that
   * carries the MANUFACTURER's code: a shop's own SKU scheme matches nothing
   * at other shops. Strip shop-specific decoration in the pipeline.
   */
  'mpn',
] as const;

export type ArukeresoMappingTarget = (typeof ARUKERESO_MAPPING_TARGETS)[number];

/** How one Árukereső feed field maps onto a target field. */
export interface ArukeresoFieldMapping {
  /**
   * Feed field name, seeding the pipeline's input. Matched case-insensitively
   * with `_`, `-` and spaces stripped, because at least three spelling families
   * exist in the wild for the same fields — official PascalCase (`ProductUrl`),
   * the docs' own lowercase CSV headers (`producturl`) and ShopRenter's
   * snake_case (`product_url`).
   *
   * Optional only when a `pipeline` needs no input — a `literal` supplying a
   * currency code the feed format has no field for, say. Naming an unrelated
   * field just to satisfy the grammar would read as a dependency that is not
   * one.
   */
  field?: string;
  /** Optional transform, using the same op vocabulary as scraping configs. */
  pipeline?: ScrapeOperation[];
}

/**
 * Config for `type: 'arukereso'` — a product feed.
 *
 * `field` does the addressing and the op pipeline does the transforming, which
 * is why this type needs no ops of its own.
 */
export interface ArukeresoSourceConfig {
  baseUrl: string;
  /** The feed URL. Fetched over plain HTTP — never through the paid scraper. */
  feedUrl: string;
  /** 'auto' sniffs the content type and the first bytes. */
  format?: 'auto' | 'xml' | 'csv';
  csv?: {
    /** 'auto' detects between comma, semicolon and tab from the header row. */
    delimiter?: 'auto' | ',' | ';' | '\t';
  };
  categories?: Record<string, ProductSourceCategoryConfig>;
  /**
   * Resolves the feed's category path to one of our category slugs.
   *
   * Required, unlike the scraping shape's optional pieces: a feed is the whole
   * catalog, so a source that cannot categorise an item cannot import anything
   * at all. Use an `always` rule for a single-category shop.
   */
  category: {
    /** Pipeline turning the raw category value into a matchable label. */
    labelFrom?: ScrapeOperation[];
    slugLookup: CategoryLookupRule[];
  };
  /**
   * Hard ceiling on how many items one run imports. Unset means no ceiling,
   * which is what a production source wants.
   *
   * A feed run is a single in-process pass, so here the cap is exactly what it
   * says: the run stops importing after this many products. Counted in items
   * IMPORTED, not items seen — a cap of 10 alongside a `filter` yields ten
   * matching products, not ten attempts. The feed is still downloaded whole;
   * this bounds the expensive half (LLM post-processing and writes), not the
   * cheap one.
   */
  maxItems?: number;
  /** Narrows a run to a subset of the catalogue. See ProductSourceFilterConfig. */
  filter?: ProductSourceFilterConfig;
  /** The feed's attribute pairs are its spec table — see ProductSourceIdentityExtractionConfig. */
  identityExtraction?: ProductSourceIdentityExtractionConfig;
  mapping: Record<string, ArukeresoFieldMapping>;
  /** Keyed by category slug, exactly as detailPage.specMapping is. */
  specMapping?: Record<string, SourceSpecConfig>;
  /**
   * The LLM post-processing pass, identical in meaning to
   * `detailPage.postProcess` and read by the same service.
   *
   * A feed needs it at least as much as a page does: Árukereső's `name` field
   * is the shop's full marketing title, so without post-processing every feed
   * product's `model` is that whole string — which is exactly the input
   * identity resolution is worst at.
   */
  postProcess?: ProductSourcePostProcessConfig;
}

/**
 * The stored `ProductSource.config`. Which shape applies is decided by
 * `ProductSource.type`, which is fixed at creation — the two share no keys, so
 * reading one as the other yields nothing rather than something subtly wrong.
 */
export type ProductSourceConfig = ScrapingSourceConfig | ArukeresoSourceConfig;

/**
 * Narrow a stored config to the scraping shape.
 *
 * Config shape is decided by ProductSource.type, which TypeScript cannot see
 * through `source.config` alone — so scraping-only code (the whole detail-page
 * pipeline, the interpreter's list/detail runners) asks for the narrowing
 * explicitly rather than casting. Throwing is right: reaching detail-page code
 * with a feed source is a wiring bug, and the two shapes share no keys, so
 * carrying on would read `undefined` for everything.
 */
export function asScrapingConfig(
  config: ProductSourceConfig,
  sourceLabel?: string,
): ScrapingSourceConfig {
  if (!isScrapingConfig(config)) {
    throw new Error(
      `Expected a scraping config${sourceLabel ? ` for "${sourceLabel}"` : ''}, ` +
        `but this source's config is not one. Check ProductSource.type.`,
    );
  }
  return config;
}

/** Narrow a stored config to the Árukereső shape. See asScrapingConfig. */
export function asArukeresoConfig(
  config: ProductSourceConfig,
  sourceLabel?: string,
): ArukeresoSourceConfig {
  if (!isArukeresoConfig(config)) {
    throw new Error(
      `Expected an Árukereső config${sourceLabel ? ` for "${sourceLabel}"` : ''}, ` +
        `but this source's config is not one. Check ProductSource.type.`,
    );
  }
  return config;
}

/** Structural test — `listPage` exists only on the scraping shape. */
export function isScrapingConfig(
  config: ProductSourceConfig | undefined | null,
): config is ScrapingSourceConfig {
  return !!config && 'listPage' in config;
}

/** Structural test — `feedUrl` exists only on the Árukereső shape. */
export function isArukeresoConfig(
  config: ProductSourceConfig | undefined | null,
): config is ArukeresoSourceConfig {
  return !!config && 'feedUrl' in config;
}
