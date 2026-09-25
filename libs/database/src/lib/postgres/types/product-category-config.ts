export interface CategoryMatchingConfig {
  /** Per-spec overrides for numeric comparison, keyed by spec name.
   *
   *  Numeric specs are compared with a **relative** tolerance by default, which
   *  suits magnitudes (750Wh vs 760Wh) but is meaningless for identity-bearing
   *  integers: at the 5% default, every model year from 2015 to 2030 matches
   *  every other, so `modelYear` never contradicts anything. Listing a spec here
   *  is what makes it compare the way it reads. */
  specTolerances?: Record<string, SpecTolerance>;
}

/** How far apart two numeric values may be and still count as the same.
 *
 *  Exactly one of the two applies — `absolute` when set, otherwise `percent`.
 *  `absolute: 0` means exact equality, which is what a year, a generation or a
 *  discrete rating needs. */
export interface SpecTolerance {
  /** Maximum allowed difference in the value's own units. `0` = exact. */
  absolute?: number;
  /** Maximum allowed difference as a percentage of the larger value. */
  percent?: number;
}

export interface CategoryPromptConfig {
  /** Disambiguation suffix appended to deterministic web-search keywords compiled
   *  by WebResearchAgent. Carries category-distinguishing tokens — e.g.
   *  "monitor", "ultrawide monitor", "headphones", "projector" — so generic-named
   *  products land on the right SKU pages. */
  searchKeywordSuffix?: string;
}

// ─── Spec Extraction Config ─────────────────────────────────────────────────

export type SpecExtractMode =
  | 'raw'
  | 'number'
  | 'secondNumber'
  | 'roundedNumber'
  | 'ceiledNumber'
  | 'removeWhitespace'
  | 'list'
  | 'regexpList'
  | 'cmToInchList'
  | 'mmToCmAndInchList'
  | 'standardRatio'
  | 'shuffledList';

export interface SourceSpecMapping {
  key: string;
  labels: string[];
  sectionTitle?: string;
  extract?: SpecExtractMode;
  extractPatterns?: string[];
  trimSuffixes?: string[];
  replacePatterns?: Array<{ from: string; to: string }>;
  /**
   * Deterministic pre-translation value remap. When the raw (pre-translation)
   * value matches a key case-insensitively, short-circuit translation entirely
   * and use the mapped canonical value. Keeps closed-set categorical fields
   * (e.g. headphone type) stable without LLM variance.
   */
  valueMap?: Record<string, string>;
  preferredValueIndex?: number;
  skipValues?: string[];
}

export interface CalculatedSpecRule {
  key: string;
  rule: 'presentIfKey' | 'featureSearch' | 'presentLabels';
  source: string | string[];
  keywords?: string[];
}

export interface SourceSpecConfig {
  mappings: SourceSpecMapping[];
  calculated?: CalculatedSpecRule[];
}

/**
 * Synchronous lookup: given a raw source value, return its translation (or the raw
 * value if untranslated). Populated by a pre-translation pass — callers build the
 * function from a translation result Map and pass it into spec extraction. See
 * `TranslationService.translateBatch()` in `@fittkereso-backend/translation`.
 */
export type SpecValueTranslator = (
  text: string | undefined,
) => string | undefined;

// ─── Filter Config ───────────────────────────────────────────────────────────

export type FilterType = 'range' | 'multiselect' | 'boolean';

export interface FilterBucket {
  label: string;
  min?: number;
  max?: number;
}

export interface FilterSpecConfig {
  key: string;
  filterType: FilterType;
  buckets?: FilterBucket[];
  openByDefault?: boolean;
}

// ─── Category Config ────────────────────────────────────────────────────────

export interface ProductCategoryConfig {
  keywordIdentifiers?: string[];
  matchingConfig?: CategoryMatchingConfig;
  promptConfig?: CategoryPromptConfig;
  /** Ordered list of spec keys to use for product context and scoring (e.g. ["screenSize", "resolution", "refreshRate"]). */
  primarySpecs?: string[];
  /** Secondary spec keys for matching disambiguation.
   *  Compared alongside primarySpecs but with softer penalties and lower contradiction weight.
   *  Missing values on either side are treated as neutral (not compared).
   *  Mismatches weaken match confidence and can prevent false merges
   *  between products that share identical primarySpecs.
   *  Example: ["brightness", "weightWithStand", "powerConsumption"] */
  matcherSpecs?: string[];
  /** Hierarchical value relationships for spec comparison.
   *  Maps spec key → parent value → list of child values that are subtypes of the parent.
   *  When one product has a parent value and the other has a child value (or vice versa),
   *  the comparison result is 'compatible' rather than 'mismatch'.
   *  Example: { "panelType": { "OLED": ["QD-OLED", "W-OLED"] } } */
  matcherSpecHierarchies?: Record<string, Record<string, string[]>>;
  /** Public-facing description for the category page SEO and header. */
  categoryDescription?: string;
  /** Ordered list of filterable specs with their UI type. */
  filterSpecs?: FilterSpecConfig[];
  /** Strategy for computing normalizedName/normalizedSourceName.
   *  'digit-heuristic' (default): keep only whitespace-delimited words containing
   *  a digit — correct when the model code is the one alphanumeric token
   *  (monitors: "PG32UCDP").
   *  'full': keep the whole brand-stripped string, lowercased and whitespace-
   *  collapsed only — no word-level discarding. Use when there's no reliable
   *  digit/alpha split between "identity" and "noise" (ebikes: "MACINA SCARP SX
   *  PRESTIGE Di2" has no digits at all). Relies on the LLM post-process step
   *  (ProductSourcePostProcessService) already having stripped offer-level
   *  attributes like size/color from `model` upstream.
   *  'full-sorted': same as 'full', but additionally sorts the whitespace
   *  tokens alphabetically before joining, so two sources whose post-processed
   *  model strings differ only in word order (e.g. "Cross Macina 720" vs.
   *  "Macina Cross 720") produce the same key. This key is queried by pg_trgm
   *  similarity() (ProductFuzzySearchService, the nightly dedup job's recall)
   *  in addition to the exact-match Path 1 lookup, so the fix applies to both.
   *  Not used for the embedding column (ProductEmbeddingService), which is
   *  deliberately natural-language for its semantic model. */
  normalizationStrategy?: 'digit-heuristic' | 'full' | 'full-sorted';
  /** Spec keys (must exist in the category's jsonSchema.json) that describe a
   *  purchasable variant/listing attribute rather than the product model's
   *  identity — e.g. frameSize, color. Values for these keys are never merged
   *  into ProductModel.specs; they're captured per-Offer instead, so two
   *  listings of the same model in different sizes/colors match to one
   *  ProductModel with multiple Offer rows instead of each variant tripping
   *  the model-level spec gates in `libs/product-identity`. Always optional per-listing — absence of a value is normal, not
   *  an error. A free-text one (a string field with no enum, e.g. color) is the
   *  shop's own name for the variant, so it is kept exactly as the source
   *  writes it and never translated (getVerbatimSpecKeys in libs/product). */
  offerLevelSpecs?: string[];
  /** Ordered subset of spec keys (must exist in the category's
   *  jsonSchema.json) to surface on the storefront list/card view, where
   *  space is limited — e.g. ["modelYear", "frameType", "batteryCapacity"].
   *  Distinct from primarySpecs/filterSpecs, which drive matching and
   *  filtering rather than list-view display. Unset or empty means no
   *  curated list-view subset (callers fall back to their own default). */
  displayedSpecsInList?: string[];
}
