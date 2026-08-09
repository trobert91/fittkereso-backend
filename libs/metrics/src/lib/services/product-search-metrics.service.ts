import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  PRODUCT_RESOLUTION_WEB_SEARCH_TOTAL,
  PRODUCT_RESOLUTION_WEB_SEARCH_DURATION_SECONDS,
  PRODUCT_RESOLUTION_WEB_SEARCH_CACHE_TOTAL,
  PRODUCT_RESOLUTION_WEB_SEARCH_RESULTS,
} from '../metric-names';

@Injectable()
export class ProductSearchMetricsService {
  private readonly webSearchTotal: client.Counter<string>;
  private readonly webSearchDuration: client.Histogram<string>;
  private readonly webSearchCacheTotal: client.Counter<string>;
  private readonly webSearchResults: client.Histogram<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.webSearchTotal = new client.Counter({
      name: PRODUCT_RESOLUTION_WEB_SEARCH_TOTAL,
      help: 'Total web searches for product resolution',
      labelNames: ['provider', 'status'],
      registers: [this.prometheusService.register],
    });

    this.webSearchDuration = new client.Histogram({
      name: PRODUCT_RESOLUTION_WEB_SEARCH_DURATION_SECONDS,
      help: 'Duration of web search API calls in seconds',
      labelNames: ['provider'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
      registers: [this.prometheusService.register],
    });

    this.webSearchCacheTotal = new client.Counter({
      name: PRODUCT_RESOLUTION_WEB_SEARCH_CACHE_TOTAL,
      help: 'Web search cache hits and misses',
      labelNames: ['result'],
      registers: [this.prometheusService.register],
    });

    this.webSearchResults = new client.Histogram({
      name: PRODUCT_RESOLUTION_WEB_SEARCH_RESULTS,
      help: 'Number of results returned per web search',
      labelNames: ['provider'],
      buckets: [0, 1, 3, 5, 10, 15, 20],
      registers: [this.prometheusService.register],
    });
  }

  // ── Web Search ────────────────────────────────────────────────────────────

  recordWebSearch(
    provider: string,
    status: 'success' | 'error',
    durationSeconds: number,
    resultCount: number,
  ): void {
    this.webSearchTotal.inc({ provider, status });
    if (status === 'success') {
      this.webSearchDuration.observe({ provider }, durationSeconds);
      this.webSearchResults.observe({ provider }, resultCount);
    }
  }

  recordWebSearchCache(result: 'hit' | 'miss'): void {
    this.webSearchCacheTotal.inc({ result });
  }
}
