import { SourceSpecConfig } from './product-category-config';
import { CategoryLookupCondition, ScrapeOperation } from './scrape-operation';

/**
 * One way a listing shows it belongs to a category: `when` holds and
 * `unless` does not. A list in `when` holds when every condition does; a list
 * in `unless` blocks the rule when any condition does. The same vocabulary
 * for pages and feeds, so a shop that is both scraped and fed can share its
 * rules verbatim (`titleMatches` aside, which only a feed can test).
 */
export interface CategoryMatchRule {
  when: CategoryLookupCondition | CategoryLookupCondition[];
  unless?: CategoryLookupCondition | CategoryLookupCondition[];
}

/**
 * Everything a source knows about one of our categories, under
 * `categories.<slug>`: whether it imports it, which listings are in it, how
 * their spec rows map onto the category's schema, and which rows the identity
 * extraction reads.
 */
export interface ProductSourceCategoryConfig {
  /** Whether listings in this category are imported. */
  enabled: boolean;
  /**
   * Which listings are in this category. A listing matching any rule is in
   * it; one matching rules of two categories is ambiguous and skipped, so no
   * rule order between categories decides. A section without rules matches
   * nothing.
   */
  rules?: CategoryMatchRule[];
  /** How this source's spec rows map onto the category's spec keys. */
  specMapping?: SourceSpecConfig;
  /**
   * Allowlist of spec-table row labels sent to the identity extraction — the
   * rows that carry a primary, matcher or offer-level spec (frame, motor,
   * battery, wheels, drivetrain, weight, year). Matched ignoring case, as
   * specMapping labels are, and ignoring stray whitespace — but not accents.
   *
   * Per category because the identity fields differ between categories: an
   * e-bike's motor and battery rows mean nothing for a bike. Omit to send the
   * whole table, which suits a shop whose table is already short. Full spec
   * unification always gets the whole table regardless.
   */
  identitySpecRows?: string[];
  /**
   * Feed sources only: feed fields that become spec rows of this category's
   * listings, `{ name: label, values: [value] }` beside the feed's own
   * attributes — the category path, a code in the SKU, a line cut from the
   * description. Each is resolved like a `mapping` target, and an empty one
   * adds no row. From there the usual readers take them: `specMapping`, the
   * identity extraction (through `identitySpecRows`, or every row) and spec
   * unification. Added once the category is known, so the rules never see
   * them. A scraping source builds its rows in `detailPage.rawSpecs`.
   */
  extraSpecRows?: CategoryExtraSpecRow[];
}

/** One extra spec row of a feed source's category section. */
export interface CategoryExtraSpecRow {
  /** The row's label, as specMapping labels and identitySpecRows name it. */
  label: string;
  /** Feed field seeding the pipeline, matched as `mapping` fields are. */
  field?: string;
  /** Optional transform, using the same op vocabulary as `mapping`. */
  pipeline?: ScrapeOperation[];
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
  /**
   * Whether each listing gets the identity extraction: its model name, and
   * the identity and listing-level specs (size, colour) read off its title.
   * On by default. Off, a listing has no `model`, only its
   * title, and matching uses the title. On a source that does not identify
   * products it still decides nothing: it only names the listing and fills
   * the offer's listing-level specs the seller's higher sources lack.
   */
  identity?: boolean;
  /**
   * Whether full spec unification runs (once per product per source): every
   * schema field outside the identity set, from the listing's whole spec
   * table. On by default. Off suits a source with no spec table, a Google
   * Shopping feed say, where it would read only the title.
   */
  specs?: boolean;
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
   * What of the listing's description the identity extraction gets. Unset is
   * `none`: that call reads the name and identity fields from the title and
   * the selected spec rows. A whole description is long and talks about the
   * brand, other models and other years (a Bosch blurb's "2026 újdonságai"
   * on every bike), so `evidence` sends only the text around the category's
   * `evidenceKeywords` — the words that tell what kind of product it is,
   * which titles often leave out — and the call uses it only for the fields
   * whose values are defined. `full` sends the whole description as text.
   */
  identityDescription?: IdentityDescriptionConfig;
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

/** ProductSourcePostProcessConfig.identityDescription. */
export interface IdentityDescriptionConfig {
  /** `none` (the default): nothing; `evidence`: the text around the
   *  category's evidence keywords; `full`: the whole description. */
  mode: 'none' | 'evidence' | 'full';
  /** `evidence`: words kept on each side of a keyword (default 10). */
  windowWords?: number;
  /** `evidence`: the most characters of excerpts per listing (default 3000). */
  maxChars?: number;
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
  /** The text each category section's `rules` are matched against. */
  category: {
    breadcrumbOrSource: ScrapeOperation[];
  };
  brand: ScrapeOperation[];
  model: ScrapeOperation[];
  aliases?: ScrapeOperation[];
  releaseYear?: ScrapeOperation[];
  /**
   * The page's source-native id (SKU, product code), stable across URL
   * changes: the key of the listing's ProductSourceRecord, which a renamed
   * URL keeps. It must name exactly this page within the source. A size
   * group's shared id (ShopRenter's parent.sku, say) belongs in `siblingIds`.
   * Without it, the record is keyed by the URL slug, and a rename leaves the
   * old record behind.
   */
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
  /** One section per category, keyed by category slug. */
  categories?: Record<string, ProductSourceCategoryConfig>;
  /**
   * Hard ceiling on how many detail tasks one run queues. Unset means no
   * ceiling.
   *
   * Once the run has queued this many detail tasks, it queues no more; the
   * cards left out are found again by the next run. The run still walks every
   * list page, and still refreshes every known card in place (which queues
   * nothing), so the cap limits what a run spends on detail pages, not what
   * it sees.
   *
   * A run's list pages are separate tasks, so the count is kept in the
   * database: each list task carries the run's start (ListPageTaskPayload),
   * and DetailTaskCapService counts the source's detail tasks created since,
   * under a per-source advisory lock.
   */
  maxItems?: number;
  /** Narrows a run to a subset of the catalogue. See ProductSourceFilterConfig. */
  filter?: ProductSourceFilterConfig;
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
  /**
   * Source-native id (sku, identifier), unique per row: the key of the row's
   * listing record and its offer. Falls back to the URL slug when absent. A
   * later row repeating it under another URL is skipped.
   */
  'externalId',
  'brand',
  /**
   * The listing title. Becomes `originalName` verbatim, and `model` after the
   * post-process pass cleans it — a feed's `name` is the shop's full marketing
   * title, so the raw value is rarely a usable model name on its own.
   */
  'name',
  /** The product page URL — the offer's link. A changed URL moves the listing's record. */
  'url',
  'price',
  'priceWithoutDiscount',
  'currency',
  /** Mapped onto OfferAvailability; anything unrecognised becomes `unknown`. */
  'availability',
  /**
   * `new`, `used` or `refurbished`, case ignored — Google's `condition` column
   * as it stands. Translate other labels with `mapValue`. Empty or any other
   * value reads as new; unmapped, the seller's other sources decide, and new
   * when none does. A used-only shop maps a `literal`.
   */
  'condition',
  /** Primary image, or a list of them when the pipeline yields an array. */
  'imageUrl',
  'description',
  /** The raw category value that `category.labelFrom` and the category sections' rules consume. */
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
 * A target's mapping, or its fallbacks: tried in order, the first that gives a
 * non-empty value wins — a Google feed's price is its `sale_price` when there
 * is one, else its `price`.
 */
export type ArukeresoMappingEntry = ArukeresoFieldMapping | ArukeresoFieldMapping[];

/**
 * Config for the feed types, `arukereso` and `googleshop` — a product feed.
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
  /**
   * One section per category, keyed by category slug. A feed is the whole
   * catalog, so the sections' `rules` are what keep everything else out; use
   * an `always` rule for a single-category shop.
   */
  categories?: Record<string, ProductSourceCategoryConfig>;
  /** How the feed's category value becomes the label the sections' rules test. */
  category?: {
    /** Pipeline turning the raw category value into a matchable label. */
    labelFrom?: ScrapeOperation[];
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
  mapping: Record<string, ArukeresoMappingEntry>;
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
