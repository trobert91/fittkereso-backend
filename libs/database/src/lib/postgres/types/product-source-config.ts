import { SourceSpecConfig } from './product-category-config';
import { CategoryLookupRule, ScrapeOperation } from './scrape-operation';

export interface ProductSourceDiscoveryConfig {
  mode: 'categoryTitleMatch' | 'brandNameMatch';
  linkPipeline: ScrapeOperation[];
}

export interface ProductSourceCategoryConfig {
  enabled: boolean;
  sourceTitle?: string;
}

export interface ProductSourceIncrementalSyncConfig {
  searchKeywords?: string[];
  numResults?: number;
  urlClassify?: {
    detailUrlPattern: string;
  };
}

export interface ProductSourceListPageConfig {
  categoryName: ScrapeOperation[];
  categoryLinks: ScrapeOperation[];
  productLinks: ScrapeOperation[];
}

export interface ProductSourceOffersConfig {
  listItems: ScrapeOperation[];
  sellerName: ScrapeOperation[];
  price: ScrapeOperation[];
  /**
   * The pre-discount price pipeline. Optional: most sources don't surface a
   * separate "original price" element. Should resolve to undefined (e.g. an
   * empty selector match) on listings that aren't currently discounted,
   * rather than being run conditionally — see speedbike.hu's config for the
   * pattern.
   */
  priceWithoutDiscount?: ScrapeOperation[];
  currency?: ScrapeOperation[];
  availability?: ScrapeOperation[];
  url?: ScrapeOperation[];
  sourceListingId?: ScrapeOperation[];
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
 */
export interface ProductSourcePostProcessConfig {
  enabled: boolean;
  model?: string;
  /**
   * Reasoning toggle. Leave unset to use the service default (reasoning on at
   * `effort`). Set false for sources whose spec table is already normalized to
   * near-canonical labels (e.g. ebikeshop.hu, ambringa.hu) — those need
   * re-keying, not inference, so the reasoning tokens are pure waste. Sources
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
}

export interface ProductSourceDetailPageConfig {
  rawSpecs: ScrapeOperation[];
  category: {
    breadcrumbOrSource: ScrapeOperation[];
    slugLookup: CategoryLookupRule[];
  };
  brand: ScrapeOperation[];
  model: ScrapeOperation[];
  aliases?: ScrapeOperation[];
  releaseYear?: ScrapeOperation[];
  // Source-native listing identifier (SKU/model code/slug), stable across URL
  // changes. Extracted once here (not only inside offers.sourceListingId) so
  // ProductSourceRecord.externalId can be populated independent of whether the
  // source's config populates `offers` at all.
  externalId?: ScrapeOperation[];
  images: ScrapeOperation[];
  // Keyed by category slug — replaces the old per-category specMappings.json
  // file (which was keyed by source instead, now implicit in "which
  // ProductSource row this config belongs to").
  specMapping: Record<string, SourceSpecConfig>;
  offers?: ProductSourceOffersConfig;
  translation?: ProductSourceTranslationConfig;
  postProcess?: ProductSourcePostProcessConfig;
}

export interface ProductSourceConfig {
  baseUrl: string;
  fullSyncStartUrl?: string;
  discovery?: ProductSourceDiscoveryConfig;
  categories?: Record<string, ProductSourceCategoryConfig>;
  incrementalSync?: ProductSourceIncrementalSyncConfig;
  listPage: ProductSourceListPageConfig;
  detailPage: ProductSourceDetailPageConfig;
}
