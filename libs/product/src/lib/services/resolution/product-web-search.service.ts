/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { chain } from 'lodash';
import { format } from 'date-fns';
import { ExaSearchService } from '@fittkereso-backend/exa';
import { SerpApiService } from '@fittkereso-backend/dataforseo';
import {
  DynamicConfigService,
  DynamicConfigData,
} from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductSearchMetricsService } from '@fittkereso-backend/metrics';
import { DataForSeoLocationCode } from '@fittkereso-backend/dataforseo';

export type WebSearchProvider = 'dataforseo' | 'exa';
export const WebSearchProvider = {
  DataForSEO: 'dataforseo',
  Exa: 'exa',
} as const;

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
}

/**
 * Unified Product Web Search Service
 *
 * Provides web search with intelligent provider selection:
 * - Provider selection: Exa.ai for high-value, DataForSEO for routine
 * - Common interface: Abstracts provider differences
 */
@Injectable()
export class ProductWebSearchService {
  private readonly logger = new CustomLogger(ProductWebSearchService.name);

  constructor(
    private readonly exaSearchService: ExaSearchService,
    private readonly serpApiService: SerpApiService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly metricsService: ProductSearchMetricsService,
  ) {}

  /**
   * Perform web search with provider selection
   *
   * Flow:
   * 1. Select provider based on relevance
   * 2. Execute provider search
   * 3. Return results
   */
  public async search(
    request: ProductWebSearchRequest,
  ): Promise<ProductWebSearchResponse> {
    const webSearchConfig = this.dynamicConfigService.webSearch;

    // Step 1: Select provider based on relevance/context
    const { provider, reason: providerSelectionReason } = this.selectProvider(
      request,
      webSearchConfig,
    );

    this.logger.debug('Calling web search provider', {
      keyword: request.keyword,
      provider,
      providerSelectionReason,
      relevance: request.relevance,
      isOp: request.isOp,
    });

    // Step 2: Execute provider search
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

    return {
      results,
      provider,
      providerSelectionReason,
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

}
