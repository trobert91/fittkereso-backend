/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { chain } from 'lodash';
import { format } from 'date-fns';
import {
  WebSearchProvider,
  WebSearchCacheRepository,
} from '@fittkereso-backend/database';
import { ExaSearchService } from '@fittkereso-backend/exa';
import { SerpApiService } from '@fittkereso-backend/dataforseo';
import {
  DynamicConfigService,
  DynamicConfigData,
} from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductSearchMetricsService } from '@fittkereso-backend/metrics';
import { DataForSeoLocationCode } from '@fittkereso-backend/dataforseo';

/**
 * Request interface for product web search
 */
export interface ProductWebSearchRequest {
  /** Pre-built search keyword */
  keyword: string;
  /** Temporal constraint from comment.externalCreationTs */
  searchDate?: Date;
  /** Override automatic provider selection */
  provider?: WebSearchProvider;
  /** Comment relevance score (0-1) for provider selection */
  relevance?: number;
  /** Is this an original poster comment */
  isOp?: boolean;
}

/**
 * Individual search result from any provider
 */
export interface ProductWebSearchResult {
  title: string;
  url: string;
  description?: string;
  content?: string;
  publishedDate?: string;
}

/**
 * Response from product web search service
 */
export interface ProductWebSearchResponse {
  /** Search results in common format */
  results: ProductWebSearchResult[];
  /** Which provider was used */
  provider: WebSearchProvider;
  /** Why this provider was selected */
  providerSelectionReason:
    | 'request_override'
    | 'default_provider_exa'
    | 'default_provider_dataforseo'
    | 'op_priority'
    | 'high_relevance'
    | 'fallback_dataforseo';
  /** Whether results came from cache or API */
  source: 'cache' | 'api';
  /** Cache hit flag */
  cacheHit?: boolean;
  /** Cache metadata */
  metadata?: {
    /** Keyword similarity score (if cache hit) */
    similarity?: number;
    /** Days difference from cached date (if cache hit) */
    cacheDateDiff?: number;
    /** Cache entry ID when served from cache */
    cacheEntryId?: string;
  };
}

/**
 * Unified Product Web Search Service
 *
 * Provides cache-first web search with intelligent provider selection:
 * - Cache layer: PostgreSQL trigram similarity + date tolerance
 * - Provider selection: Exa.ai for high-value, DataForSEO for routine
 * - Common interface: Abstracts provider differences
 */
@Injectable()
export class ProductWebSearchService {
  private readonly logger = new CustomLogger(ProductWebSearchService.name);

  constructor(
    private readonly cacheRepository: WebSearchCacheRepository,
    private readonly exaSearchService: ExaSearchService,
    private readonly serpApiService: SerpApiService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly metricsService: ProductSearchMetricsService,
  ) {}

  /**
   * Perform web search with cache-first strategy
   *
   * Flow:
   * 1. Check cache (keyword similarity + date tolerance)
   * 2. If miss, select provider based on relevance
   * 3. Execute provider search
   * 4. Store in cache
   * 5. Return results
   */
  public async search(
    request: ProductWebSearchRequest,
  ): Promise<ProductWebSearchResponse> {
    const cacheConfig = this.dynamicConfigService.webSearch?.cache;

    // Normalize keyword for cache lookup
    const normalizedKeyword = this.normalizeKeyword(request.keyword);

    // Step 1: Check cache
    if (cacheConfig?.enabled ?? true) {
      const cacheHit = await this.cacheRepository.findCacheHit(
        normalizedKeyword,
        request.searchDate,
        cacheConfig?.similarityThreshold ?? 0.7,
        cacheConfig?.dateToleranceDays ?? 7,
      );

      if (cacheHit) {
        this.logger.debug('Web search cache HIT', {
          keyword: request.keyword,
          provider: cacheHit.entry.provider,
        });

        this.metricsService.recordWebSearchCache('hit');

        return {
          results: cacheHit.entry.results,
          provider: cacheHit.entry.provider,
          providerSelectionReason: 'fallback_dataforseo',
          source: 'cache',
          cacheHit: true,
          metadata: {
            similarity: cacheHit.similarity,
            cacheDateDiff: this.calculateDateDiff(
              request.searchDate,
              cacheHit.entry.searchDate,
            ),
            cacheEntryId: cacheHit.entry.id,
          },
        };
      }
    }

    this.metricsService.recordWebSearchCache('miss');

    const webSearchConfig = this.dynamicConfigService.webSearch;

    // Step 2: Select provider based on relevance/context
    const { provider, reason: providerSelectionReason } = this.selectProvider(
      request,
      webSearchConfig,
    );

    this.logger.debug('Web search cache MISS, calling provider', {
      keyword: request.keyword,
      provider,
      providerSelectionReason,
      relevance: request.relevance,
      isOp: request.isOp,
    });

    // Step 3: Execute provider search
    const searchStartTime = Date.now();
    let results: ProductWebSearchResult[];
    try {
      if (provider === WebSearchProvider.Exa) {
        results = await this.searchWithExa(request, webSearchConfig);
      } else {
        results = await this.searchWithDataForSEO(request, webSearchConfig);
      }

      const searchDuration = (Date.now() - searchStartTime) / 1000;
      this.metricsService.recordWebSearch(
        provider,
        'success',
        searchDuration,
        results.length,
      );
    } catch (error) {
      const searchDuration = (Date.now() - searchStartTime) / 1000;
      this.metricsService.recordWebSearch(provider, 'error', searchDuration, 0);
      throw error;
    }

    // Step 4: Store in cache
    if (cacheConfig?.enabled ?? true) {
      await this.cacheRepository.storeCache(
        request.keyword,
        normalizedKeyword,
        request.searchDate,
        provider,
        results,
        cacheConfig?.ttlDays ?? 90,
      );
    }

    return {
      results,
      provider,
      providerSelectionReason,
      source: 'api',
      cacheHit: false,
    };
  }

  /**
   * Select provider based on request context and configuration
   *
   * Priority:
   * 1. Explicit override in request
   * 2. Force single provider if configured
   * 3. Hybrid: Exa for OP comments
   * 4. Hybrid: Exa for high relevance (≥ threshold)
   * 5. Default: DataForSEO
   */
  private selectProvider(
    request: ProductWebSearchRequest,
    webSearchConfig: DynamicConfigData['webSearch'],
  ): {
    provider: WebSearchProvider;
    reason:
      | 'request_override'
      | 'default_provider_exa'
      | 'default_provider_dataforseo'
      | 'op_priority'
      | 'high_relevance'
      | 'fallback_dataforseo';
  } {
    // Explicit override
    if (request.provider) {
      return { provider: request.provider, reason: 'request_override' };
    }

    const strategy = webSearchConfig?.providerSelection;

    // Force single provider if configured
    if (webSearchConfig?.defaultProvider === 'exa') {
      return {
        provider: WebSearchProvider.Exa,
        reason: 'default_provider_exa',
      };
    }
    if (webSearchConfig?.defaultProvider === 'dataforseo') {
      return {
        provider: WebSearchProvider.DataForSEO,
        reason: 'default_provider_dataforseo',
      };
    }

    // Hybrid strategy: relevance-based routing
    if (request.isOp && (strategy?.useExaForOp ?? true)) {
      return { provider: WebSearchProvider.Exa, reason: 'op_priority' };
    }

    if ((request.relevance ?? 0) >= (strategy?.minRelevanceForExa ?? 0.8)) {
      return { provider: WebSearchProvider.Exa, reason: 'high_relevance' };
    }

    return {
      provider: WebSearchProvider.DataForSEO,
      reason: 'fallback_dataforseo',
    };
  }

  /**
   * Search using DataForSEO (Google SERP API)
   *
   * Features:
   * - Temporal filtering via before:YYYY-MM-DD
   * - Top organic results (title, URL, description)
   * - Cost-effective for routine searches
   */
  private async searchWithDataForSEO(
    request: ProductWebSearchRequest,
    webSearchConfig: DynamicConfigData['webSearch'],
  ): Promise<ProductWebSearchResult[]> {
    // Build keyword with temporal filter
    let keyword = request.keyword;
    if (request.searchDate) {
      const formatted = format(request.searchDate, 'yyyy-MM-dd');
      keyword = `${keyword} before:${formatted}`;
    }

    // Call DataForSEO API
    const response = await this.serpApiService.getLiveGoogleOrganicData({
      keyword,
      locationCode: DataForSeoLocationCode.US,
      languageCode: 'en',
      device: 'desktop',
      depth: webSearchConfig?.dataforseo?.maxResults ?? 15,
    });

    // Extract and normalize results
    return chain(response.tasks ?? [])
      .flatMap((t) => t.result ?? [])
      .flatMap((res) => res.items ?? [])
      .filter((item) => item.title != undefined)
      .map((item) => ({
        title: item.title!,
        url: item.url!,
        description: item.description,
      }))
      .value();
  }

  /**
   * Search using Exa.ai (Neural/Semantic Search)
   *
   * Features:
   * - Neural search for better intent understanding
   * - Full page content extraction
   * - Native temporal filtering (endPublishedDate)
   * - Higher quality for important searches
   */
  private async searchWithExa(
    request: ProductWebSearchRequest,
    webSearchConfig: DynamicConfigData['webSearch'],
  ): Promise<ProductWebSearchResult[]> {
    const exaConfig = webSearchConfig?.exa;

    // Build temporal filter
    let endPublishedDate: string | undefined;
    if (request.searchDate) {
      endPublishedDate = request.searchDate.toISOString();
    }

    // Call Exa API
    const response = await this.exaSearchService.search({
      query: request.keyword,
      endPublishedDate,
      numResults: exaConfig?.numResults ?? 10,
      useAutoprompt: exaConfig?.useAutoprompt ?? true,
      type: exaConfig?.type ?? 'neural',
      contents:
        (exaConfig?.includeContent ?? true)
          ? {
              text: {
                maxCharacters: 10000,
              },
              summary: true,
            }
          : undefined,
    });

    // Convert to common format
    return response.results.map((r) => ({
      title: r.title,
      url: r.url,
      description: r.summary,
      content: r.text,
      publishedDate: r.publishedDate,
    }));
  }

  /**
   * Normalize keyword for cache matching
   *
   * - Lowercase
   * - Trim whitespace
   * - Remove extra spaces
   */
  private normalizeKeyword(keyword: string): string {
    return keyword.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  /**
   * Calculate date difference in days
   */
  private calculateDateDiff(
    date1: Date | undefined,
    date2: Date | undefined,
  ): number | undefined {
    if (!date1 || !date2) {
      return undefined;
    }

    const diffMs = Math.abs(date1.getTime() - date2.getTime());
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
}
