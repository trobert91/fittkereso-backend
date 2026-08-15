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
  images: ScrapeOperation[];
  // Keyed by category slug — replaces the old per-category specMappings.json
  // file (which was keyed by source instead, now implicit in "which
  // ProductSource row this config belongs to").
  specMapping: Record<string, SourceSpecConfig>;
  offers?: ProductSourceOffersConfig;
  translation?: ProductSourceTranslationConfig;
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
