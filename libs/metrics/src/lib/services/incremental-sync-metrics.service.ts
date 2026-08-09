import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  EXA_API_CALL_TOTAL,
  EXA_API_DURATION_SECONDS,
  INCREMENTAL_SYNC_DURATION_SECONDS,
  INCREMENTAL_SYNC_KEYWORDS_SEARCHED_TOTAL,
  INCREMENTAL_SYNC_TASKS_CREATED_TOTAL,
  INCREMENTAL_SYNC_TOTAL,
  INCREMENTAL_SYNC_URLS_CLASSIFIED_TOTAL,
  INCREMENTAL_SYNC_URLS_DEDUPLICATED_TOTAL,
  INCREMENTAL_SYNC_URLS_DISCOVERED_TOTAL,
} from '../metric-names';

@Injectable()
export class IncrementalSyncMetricsService {
  private readonly syncTotal: client.Counter<string>;
  private readonly syncDuration: client.Histogram<string>;
  private readonly keywordsSearched: client.Counter<string>;
  private readonly urlsDiscovered: client.Counter<string>;
  private readonly urlsClassified: client.Counter<string>;
  private readonly urlsDeduplicated: client.Counter<string>;
  private readonly tasksCreated: client.Counter<string>;
  private readonly exaApiCallTotal: client.Counter<string>;
  private readonly exaApiDuration: client.Histogram<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.syncTotal = new client.Counter({
      name: INCREMENTAL_SYNC_TOTAL,
      help: 'Total incremental sync executions',
      labelNames: ['source_type', 'status'],
      registers: [this.prometheusService.register],
    });

    this.syncDuration = new client.Histogram({
      name: INCREMENTAL_SYNC_DURATION_SECONDS,
      help: 'Incremental sync duration in seconds',
      labelNames: ['source_type'],
      buckets: [1, 5, 10, 30, 60, 120, 300],
      registers: [this.prometheusService.register],
    });

    this.keywordsSearched = new client.Counter({
      name: INCREMENTAL_SYNC_KEYWORDS_SEARCHED_TOTAL,
      help: 'Total keywords searched via Exa',
      labelNames: ['source_type'],
      registers: [this.prometheusService.register],
    });

    this.urlsDiscovered = new client.Counter({
      name: INCREMENTAL_SYNC_URLS_DISCOVERED_TOTAL,
      help: 'Total raw URLs discovered from Exa',
      labelNames: ['source_type'],
      registers: [this.prometheusService.register],
    });

    this.urlsClassified = new client.Counter({
      name: INCREMENTAL_SYNC_URLS_CLASSIFIED_TOTAL,
      help: 'Total URLs passing classification',
      labelNames: ['source_type'],
      registers: [this.prometheusService.register],
    });

    this.urlsDeduplicated = new client.Counter({
      name: INCREMENTAL_SYNC_URLS_DEDUPLICATED_TOTAL,
      help: 'Total URLs skipped as already queued',
      labelNames: ['source_type'],
      registers: [this.prometheusService.register],
    });

    this.tasksCreated = new client.Counter({
      name: INCREMENTAL_SYNC_TASKS_CREATED_TOTAL,
      help: 'Total new scrape tasks created by incremental sync',
      labelNames: ['source_type'],
      registers: [this.prometheusService.register],
    });

    this.exaApiCallTotal = new client.Counter({
      name: EXA_API_CALL_TOTAL,
      help: 'Total Exa API call outcomes',
      labelNames: ['status'],
      registers: [this.prometheusService.register],
    });

    this.exaApiDuration = new client.Histogram({
      name: EXA_API_DURATION_SECONDS,
      help: 'Exa API call latency in seconds',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.prometheusService.register],
    });
  }

  syncCompleted(sourceType: string): void {
    this.syncTotal.inc({ source_type: sourceType, status: 'success' });
  }

  syncFailed(sourceType: string): void {
    this.syncTotal.inc({ source_type: sourceType, status: 'error' });
  }

  recordSyncDuration(sourceType: string, durationSeconds: number): void {
    this.syncDuration.observe({ source_type: sourceType }, durationSeconds);
  }

  keywordSearched(sourceType: string): void {
    this.keywordsSearched.inc({ source_type: sourceType });
  }

  recordUrlsDiscovered(sourceType: string, count: number): void {
    this.urlsDiscovered.inc({ source_type: sourceType }, count);
  }

  recordUrlsClassified(sourceType: string, count: number): void {
    this.urlsClassified.inc({ source_type: sourceType }, count);
  }

  recordUrlsDeduplicated(sourceType: string, count: number): void {
    this.urlsDeduplicated.inc({ source_type: sourceType }, count);
  }

  recordTasksCreated(sourceType: string, count: number): void {
    this.tasksCreated.inc({ source_type: sourceType }, count);
  }

  exaApiCallCompleted(): void {
    this.exaApiCallTotal.inc({ status: 'success' });
  }

  exaApiCallFailed(): void {
    this.exaApiCallTotal.inc({ status: 'error' });
  }

  recordExaApiDuration(durationSeconds: number): void {
    this.exaApiDuration.observe(durationSeconds);
  }
}
