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
  // changes. Extracted once here (not only inside offers.itemPipeline) so
  // ProductSourceRecord.externalId can be populated independent of whether the
  // source's config populates `offers` at all. May be a group-level id shared
  // across variant siblings (e.g. ShopRenter's parent.sku) when the source
  // exposes one — see offerLinks below.
  externalId?: ScrapeOperation[];
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
   * ScrapeTask is queued. Each fetched sibling still gets its own
   * ProductSourceRecord (one per URL) under the same resolved ProductModel.
   * Absent/empty for the overwhelming majority of sources.
   */
  offerLinks?: ScrapeOperation[];
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
