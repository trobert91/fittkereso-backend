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
 * (ProductSourcePostProcessService) — spec unification plus model-name
 * cleanup — which runs after the deterministic SourceSpecMapping[]
 * extraction. The category-level pieces the LLM call needs (canonical
 * schema, golden sample) live in category config, not here — every source
 * in a category shares them.
 */
export interface ProductSourceSpecUnificationConfig {
  enabled: boolean;
  model?: string;
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
  specUnification?: ProductSourceSpecUnificationConfig;
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
