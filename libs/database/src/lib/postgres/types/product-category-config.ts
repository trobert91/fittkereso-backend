import { NegativeTerm, RelevanceTerm } from "../../models/relevance-terms";

export interface TokenPriorityMap {
  prefix?: number; // e.g., size in monitors (27), generation in GPUs (4000)
  generation?: number; // e.g., generation markers
  model?: number; // core model identifier
  variant?: number; // variant suffixes
}

export interface StrictnessOverrides {
  tokenOverlap?: number; // minimum token overlap ratio
  numericHitRatio?: number; // minimum numeric token match ratio
  maxScore?: number; // maximum acceptable score
}

/**
 * Numeric token rule for matching
 */
export interface NumericTokenRule {
  pattern: string; // regex pattern as string
  weight: number;
  description: string;
  critical: boolean; // Critical tokens must match exactly
}

export interface CategoryMatchingConfig {
  strictness?: "strict" | "moderate" | "loose";

  // Patterns that must be preserved during normalization
  criticalTokenPatterns?: string[]; // regex patterns as strings, e.g., '\\d{2}[A-Z]{2}\\d' for monitors

  // Numeric token rules (pattern-based weighting)
  numericTokenRules?: NumericTokenRule[];

  // Weight multipliers for token positions/types
  tokenPriorityMap?: TokenPriorityMap;

  // Threshold overrides for this category
  strictnessOverrides?: StrictnessOverrides;

  // Token grouping hints for normalization
  preserveTokenGroups?: boolean; // whether to preserve certain token combinations
  tokenSeparator?: string; // preferred separator when reconstructing tokens

  /** Maximum number of matcherSpec mismatches allowed before rejecting in strict mode.
   *  Rejection occurs when matcherSpecMismatches > maxMatcherSpecMismatches.
   *  Default: 2. Categories with few matcherSpecs should use 0 or 1. */
  maxMatcherSpecMismatches?: number;
}

/**
 * One worked case in the validation prompt's catalogue. Cases are not
 * segmented by issue type — each case is a self-contained
 * input + expected-output pair that may exercise zero, one, or several
 * issue types. Silent-approval teachers (`expected.refs: []`) are
 * encouraged: a few "looks like a flag, but stay silent" cases teach
 * restraint better than per-step prose.
 */
export interface ValidationCase {
  /** Short annotation describing what's interesting about this case (rendered next to it in the prompt). */
  note: string;
  /** Pre-formatted [VALIDATE] comment + ref block, rendered verbatim into the prompt as the case's input. */
  input: string;
  /** The validation output an ideal LLM would emit for this input. Must conform to the validation JSON schema. */
  expected: { refs: Array<Record<string, unknown>> };
}

export type ValidationCases = ValidationCase[];

export interface CategoryPromptConfig {
  specialInstructions?: string;
  /** Disambiguation suffix appended to deterministic web-search keywords compiled
   *  by WebResearchAgent. Carries category-distinguishing tokens — e.g.
   *  "monitor", "ultrawide monitor", "headphones", "projector" — so generic-named
   *  products land on the right SKU pages. */
  searchKeywordSuffix?: string;
  /** Whitelist of valid spec types for this category. When set, only extract specs that match these types.
   *  Each entry has a camelCase key matching DB OrderedSpec.key values and example values for the prompt.
   *  Anything not in this list (user settings, prices, calibration values, etc.) should be omitted.
   *
   *  Optional fields shape the prompt rendering:
   *  - `format` — one-line directive describing the canonical value shape (e.g. "WIDTHxHEIGHT in pixels").
   *  - `examples` — comma-separated good values; rendered as the canonical vocabulary.
   *  - `avoid` — shorthand tokens the LLM commonly emits but must NOT extract (e.g. ["WQHD", "4K", "1440p"]).
   *  - `hint` — free-form extra guidance rendered after the structured lines (use sparingly). */
  validSpecs?: Array<{
    name: string;
    examples: string;
    format?: string;
    avoid?: string[];
    hint?: string;
  }>;
  /** JSON example object for the extraction prompt OUTPUT FORMAT section.
   *  Serialized with JSON.stringify(_, null, 2) and injected into the prompt.
   *  When absent, default monitor-centric examples are used.
   *  Should match the extraction output schema (object with a "comments" array). */
  extractionExamples?: Record<string, unknown>;
  /** JSON example object for the labeling prompt OUTPUT FORMAT section.
   *  Serialized with JSON.stringify(_, null, 2) and injected into the prompt.
   *  When absent, default labeling examples are used.
   *  Should match the labeling output schema (object with "products" and "quotes" arrays). */
  labelingExamples?: Record<string, unknown>;
  /** JSON example object for the identification prompt EXAMPLES section.
   *  Serialized with JSON.stringify(_, null, 2) and injected into the prompt.
   *  When absent, a small generic fallback is used.
   *  Should match the identification output schema (object with a "comments" array).
   *  May include schema-ignored "_" fields per comment for in-block rationale. */
  identificationExamples?: Record<string, unknown>;
  /** Worked-case catalogue for the validation prompt. An array of
   *  `{ note, input, expected }` cases rendered verbatim into the prompt's
   *  WORKED CASES section. Cases are not keyed by issue type — each case
   *  may exercise zero (silent-approval teacher), one, or several types.
   *  Categories that omit this field get a neutral generic fallback. */
  validationCases?: ValidationCases;
  /** Category-specific tiebreaker paragraphs injected verbatim into STEP 2
   *  (use-case evidence) of the labeling prompt as a discriminator block.
   *  Each entry is a self-contained paragraph (one or more sentences).
   *  Example for monitors: a VRR/G-Sync vs cabling tiebreaker. Omit when
   *  no category-specific discriminators are needed. */
  labelingDiscriminators?: string[];

  /** Category-specific product identification examples for the extraction prompt.
   *  Shows how to split a mentioned product into brand + model fields.
   *  Example: { mentioned: "MSI MPG 341CQPX", brand: "MSI", model: "MPG 341CQPX" } */
  productIdExamples?: Array<{
    mentioned: string;
    brand: string;
    model: string;
  }>;

  /** Category-specific brand correctness examples showing cross-brand attribution.
   *  Example: { mentioned: "AW3418DW", brand: "Alienware", model: "AW3418DW", context: "in an MSI discussion" } */
  brandCorrectnessExamples?: Array<{
    mentioned: string;
    brand: string;
    model: string;
    context: string;
  }>;

  /** Technology descriptors that are NOT standalone products for this category.
   *  These should only be extracted when attached to a brand or model name.
   *  Example for monitors: ["OLED", "QD-OLED", "IPS", "VA", "Mini LED"] */
  technologyDescriptors?: string[];

  /** Generic product type word used in this category for pronoun resolution.
   *  Example: "monitor" for Monitors, "headphones" for Headphones, "keyboard" for Keyboards */
  productTypeWord?: string;

  /** Explicit categories a quote must fall into to be extracted.
   *  Used across extractor, labeler, and validator prompts.
   *  When not set, DEFAULT_QUOTE_CATEGORIES are used as fallback. */
  quoteCategories?: Array<{
    label: string;
    description: string;
    example: string;
  }>;

  /** Category-specific quote examples showing good and bad extraction patterns.
   *  Injected into the extraction prompt to guide the LLM. */
  quoteExamples?: {
    good?: Array<{ text: string; why: string }>;
    bad?: Array<{ text: string; why: string }>;
  };

  /** Category-specific disambiguation examples for cheat sheet matching.
   *  suffix: pairs that are the same product (color/suffix variant).
   *  abbreviated: abbreviated name → canonical name.
   *  variant: pairs that are DIFFERENT products despite similar names. */
  disambiguationExamples?: {
    suffix?: Array<[string, string]>;
    abbreviated?: Array<[string, string]>;
    variant?: Array<[string, string]>;
  };

  /** Category-specific validation examples injected into the validation prompt. */
  validationConfig?: {
    /** Examples of wrong_product issues — show the LLM what product mismatches look like.
     *  shouldFlag: true = flag, false = acceptable (approve). */
    wrongProductExamples?: Array<{
      mentioned: string;
      resolvedTo: string;
      shouldFlag: boolean;
      reason: string;
    }>;
    /** User setting patterns that are NOT spec conflicts.
     *  E.g. "I use 120Hz" on a 240Hz monitor — user chose that setting. */
    userSettingPatterns?: string[];
  };
}

// ─── Spec Extraction Config ─────────────────────────────────────────────────

export type SpecExtractMode =
  | "raw"
  | "number"
  | "secondNumber"
  | "roundedNumber"
  | "ceiledNumber"
  | "removeWhitespace"
  | "list"
  | "regexpList"
  | "cmToInchList"
  | "mmToCmAndInchList"
  | "standardRatio"
  | "shuffledList";

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
  rule: "presentIfKey" | "featureSearch" | "presentLabels";
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
 * `TranslationService.translateBatch()` in `@ebike-backend/translation`.
 */
export type SpecValueTranslator = (
  text: string | undefined,
) => string | undefined;

// ─── Filter Config ───────────────────────────────────────────────────────────

export type FilterType = "range" | "multiselect" | "boolean";

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

export interface SubredditBoost {
  name: string;
  boost: number;
}

export interface UseCaseConfig {
  label: string;
  description?: string;
  /** Trigger terms that imply this use case even without an explicit mention.
   *  When a quote mentions any of these terms, the labeling prompt instructs the
   *  LLM to tag this useCase. Replaces the former `promptConfig.useCaseImplications`. */
  implications?: string[];
}

/** Single issue entry — flat top-level vocabulary. `feature` declares the
 *  parent feature this issue aggregates under at scoring time. Issues whose
 *  `feature` does not match any entry in the category's `features` list are
 *  emitted in the labeling vocabulary but contribute no feature score. */
export interface IssueConfig {
  label: string;
  feature: string;
  description: string;
}

export interface FeatureLabelConfig {
  label: string;
  /** Long description for category-config UI. Not used by prompts. */
  description?: string;
  /** Short disambiguation hint injected into the labeling prompt. Only needed for ambiguous features. */
  shortDescription?: string;
  /** @deprecated Nested issues — kept temporarily for categories that have
   *  not been migrated to the top-level `issues[]` array on the config.
   *  Read via `getIssueLabels(config)` which merges both shapes. */
  issues?: Array<{ label: string; description: string }>;
}

/** Flattened view of an issue plus its parent feature. The same shape now
 *  matches `IssueConfig` 1:1; kept as a separate alias for the consumers
 *  (labeling prompt grouping, validation index lookup) that previously
 *  consumed it via `flattenIssueLabels`. */
export interface IssueLabelConfig {
  label: string;
  feature: string;
  description: string;
}

/** Materialise the closed-list issue vocabulary for a category.
 *
 *  Prefers the top-level `config.issues` array (new shape). Falls back to
 *  `features[].issues[]` (legacy nested shape) for categories that have not
 *  been migrated yet. When a category provides both, the top-level array
 *  wins and the nested entries are ignored.
 *
 *  Order: top-level array preserves authoring order; legacy fallback
 *  preserves feature order, then issue order within each feature.
 */
export function getIssueLabels(
  config: ProductCategoryConfig | undefined,
): IssueLabelConfig[] {
  if (!config) return [];
  if (config.issues?.length) {
    return config.issues.map((issue) => ({
      label: issue.label,
      feature: issue.feature,
      description: issue.description,
    }));
  }
  const out: IssueLabelConfig[] = [];
  for (const feature of config.features ?? []) {
    for (const issue of feature.issues ?? []) {
      out.push({
        label: issue.label,
        feature: feature.label,
        description: issue.description,
      });
    }
  }
  return out;
}

/** @deprecated Use `getIssueLabels(config)` instead. Kept as a thin shim for
 *  call sites that only have the features array on hand; it walks only the
 *  legacy nested shape and is blind to top-level `issues[]`. */
export function flattenIssueLabels(
  features: FeatureLabelConfig[] | undefined,
): IssueLabelConfig[] {
  const out: IssueLabelConfig[] = [];
  for (const feature of features ?? []) {
    for (const issue of feature.issues ?? []) {
      out.push({
        label: issue.label,
        feature: feature.label,
        description: issue.description,
      });
    }
  }
  return out;
}

/** Convenience: assemble the implications map for the labeling prompt from
 *  `useCases[].implications`. Replaces the former `promptConfig.useCaseImplications` map. */
export function flattenUseCaseImplications(
  useCases: UseCaseConfig[] | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const useCase of useCases ?? []) {
    if (useCase.implications?.length) {
      out[useCase.label] = useCase.implications;
    }
  }
  return out;
}

export interface ProductCategoryConfig {
  keywordIdentifiers?: string[];
  /** Subreddits that signal this category. Applies an additive score boost when a thread is from a matching subreddit. */
  subreddits?: SubredditBoost[];
  relevanceTerms?: RelevanceTerm[];
  /** Terms whose presence in thread content signals this category is unlikely. Applied as multiplicative score penalties. */
  negativeTerms?: NegativeTerm[];
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
  /** Closed-list use case vocabulary. The labeling prompt renders the full
   *  `label — description` form; consumers that only need the bare labels
   *  (search keyword expansion, public API responses) derive them as
   *  `useCases.map(c => c.label)`. */
  useCases?: UseCaseConfig[];
  /** Closed-list feature vocabulary. Issues live in the top-level
   *  `issues[]` array below; the legacy `features[].issues[]` shape is
   *  still read as a fallback by `getIssueLabels`. */
  features?: FeatureLabelConfig[];
  /** Closed-list issue vocabulary, each declaring its parent feature for
   *  rating aggregation. Replaces the nested `features[].issues[]` shape
   *  for categories that have been migrated. */
  issues?: IssueConfig[];
}
