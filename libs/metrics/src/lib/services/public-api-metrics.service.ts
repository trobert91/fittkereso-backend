import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  HTTP_REQUESTS_TOTAL,
  HTTP_REQUEST_DURATION_SECONDS,
  SEARCH_QUERIES_TOTAL,
  SEARCH_ZERO_RESULTS_TOTAL,
  DB_QUERY_DURATION_SECONDS,
  RECAPTCHA_REJECTIONS_TOTAL,
  DYNAMIC_CONFIG_RELOADS_TOTAL,
} from '../metric-names';

@Injectable()
export class PublicApiMetricsService {
  private readonly httpRequestsCounter: client.Counter<string>;
  private readonly httpRequestDurationHistogram: client.Histogram<string>;
  private readonly searchQueriesCounter: client.Counter<string>;
  private readonly searchZeroResultsCounter: client.Counter<string>;
  private readonly dbQueryDurationHistogram: client.Histogram<string>;
  private readonly recaptchaRejectionsCounter: client.Counter<string>;
  private readonly dynamicConfigReloadsCounter: client.Counter<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.httpRequestsCounter = new client.Counter({
      name: HTTP_REQUESTS_TOTAL,
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.prometheusService.register],
    });

    this.httpRequestDurationHistogram = new client.Histogram({
      name: HTTP_REQUEST_DURATION_SECONDS,
      help: 'HTTP request duration in seconds',
      labelNames: ['route'],
      registers: [this.prometheusService.register],
    });

    this.searchQueriesCounter = new client.Counter({
      name: SEARCH_QUERIES_TOTAL,
      help: 'Total number of search queries',
      labelNames: ['endpoint', 'has_results'],
      registers: [this.prometheusService.register],
    });

    this.searchZeroResultsCounter = new client.Counter({
      name: SEARCH_ZERO_RESULTS_TOTAL,
      help: 'Total number of search queries with zero results',
      registers: [this.prometheusService.register],
    });

    this.dbQueryDurationHistogram = new client.Histogram({
      name: DB_QUERY_DURATION_SECONDS,
      help: 'Database query duration in seconds',
      registers: [this.prometheusService.register],
    });

    this.recaptchaRejectionsCounter = new client.Counter({
      name: RECAPTCHA_REJECTIONS_TOTAL,
      help: 'Total number of reCAPTCHA rejections',
      labelNames: ['action'],
      registers: [this.prometheusService.register],
    });

    this.dynamicConfigReloadsCounter = new client.Counter({
      name: DYNAMIC_CONFIG_RELOADS_TOTAL,
      help: 'Total number of dynamic config reloads',
      registers: [this.prometheusService.register],
    });
  }

  httpRequest(method: string, route: string, statusCode: number): void {
    this.httpRequestsCounter.inc({
      method,
      route,
      status_code: String(statusCode),
    });
  }

  httpRequestDuration(route: string, durationSeconds: number): void {
    this.httpRequestDurationHistogram.observe({ route }, durationSeconds);
  }

  searchQuery(endpoint: string, hasResults: boolean): void {
    this.searchQueriesCounter.inc({
      endpoint,
      has_results: String(hasResults),
    });
    if (!hasResults) {
      this.searchZeroResultsCounter.inc();
    }
  }

  dbQueryDuration(durationSeconds: number): void {
    this.dbQueryDurationHistogram.observe(durationSeconds);
  }

  recaptchaRejection(action: string): void {
    this.recaptchaRejectionsCounter.inc({ action });
  }

  dynamicConfigReload(): void {
    this.dynamicConfigReloadsCounter.inc();
  }
}
