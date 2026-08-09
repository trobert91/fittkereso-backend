import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  FULL_SYNC_CATEGORIES_DISCOVERED_TOTAL,
  FULL_SYNC_DURATION_SECONDS,
  FULL_SYNC_LIST_TASKS_CREATED_TOTAL,
  FULL_SYNC_TOTAL,
  LIST_PAGE_DETAIL_TASKS_CREATED_TOTAL,
  LIST_PAGE_PRODUCTS_FOUND_TOTAL,
  LIST_PAGE_PRODUCTS_SKIPPED_TOTAL,
  SCRAPE_TASK_QUEUE_DEPTH,
} from '../metric-names';

@Injectable()
export class ProductCollectionMetricsService {
  private readonly fullSyncTotal: client.Counter<string>;
  private readonly fullSyncDuration: client.Histogram<string>;
  private readonly categoriesDiscovered: client.Counter<string>;
  private readonly listTasksCreated: client.Counter<string>;
  private readonly listPageProductsFound: client.Counter<string>;
  private readonly listPageProductsSkipped: client.Counter<string>;
  private readonly listPageDetailTasksCreated: client.Counter<string>;
  private readonly queueDepthGauge: client.Gauge<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.fullSyncTotal = new client.Counter({
      name: FULL_SYNC_TOTAL,
      help: 'Total full sync executions',
      labelNames: ['source_type', 'status'],
      registers: [this.prometheusService.register],
    });

    this.fullSyncDuration = new client.Histogram({
      name: FULL_SYNC_DURATION_SECONDS,
      help: 'Full sync duration in seconds',
      labelNames: ['source_type'],
      buckets: [1, 5, 10, 30, 60, 120, 300],
      registers: [this.prometheusService.register],
    });

    this.categoriesDiscovered = new client.Counter({
      name: FULL_SYNC_CATEGORIES_DISCOVERED_TOTAL,
      help: 'Total categories/brands discovered from index pages',
      labelNames: ['source_type'],
      registers: [this.prometheusService.register],
    });

    this.listTasksCreated = new client.Counter({
      name: FULL_SYNC_LIST_TASKS_CREATED_TOTAL,
      help: 'Total list tasks created during full sync',
      labelNames: ['source_type'],
      registers: [this.prometheusService.register],
    });

    this.listPageProductsFound = new client.Counter({
      name: LIST_PAGE_PRODUCTS_FOUND_TOTAL,
      help: 'Total product links extracted from list pages',
      labelNames: ['source_type'],
      registers: [this.prometheusService.register],
    });

    this.listPageProductsSkipped = new client.Counter({
      name: LIST_PAGE_PRODUCTS_SKIPPED_TOTAL,
      help: 'Total products skipped on list pages',
      labelNames: ['source_type', 'reason'],
      registers: [this.prometheusService.register],
    });

    this.listPageDetailTasksCreated = new client.Counter({
      name: LIST_PAGE_DETAIL_TASKS_CREATED_TOTAL,
      help: 'Total detail tasks created from list pages',
      labelNames: ['source_type'],
      registers: [this.prometheusService.register],
    });

    this.queueDepthGauge = new client.Gauge({
      name: SCRAPE_TASK_QUEUE_DEPTH,
      help: 'Current scrape tasks by queue, source, and status',
      labelNames: ['queue_name', 'source_type', 'status'],
      registers: [this.prometheusService.register],
    });
  }

  fullSyncCompleted(sourceType: string): void {
    this.fullSyncTotal.inc({ source_type: sourceType, status: 'success' });
  }

  fullSyncFailed(sourceType: string): void {
    this.fullSyncTotal.inc({ source_type: sourceType, status: 'error' });
  }

  recordFullSyncDuration(sourceType: string, durationSeconds: number): void {
    this.fullSyncDuration.observe({ source_type: sourceType }, durationSeconds);
  }

  recordCategoriesDiscovered(sourceType: string, count: number): void {
    this.categoriesDiscovered.inc({ source_type: sourceType }, count);
  }

  recordListTasksCreated(sourceType: string, count: number): void {
    this.listTasksCreated.inc({ source_type: sourceType }, count);
  }

  recordProductsFound(sourceType: string, count: number): void {
    this.listPageProductsFound.inc({ source_type: sourceType }, count);
  }

  productSkipped(sourceType: string, reason: string): void {
    this.listPageProductsSkipped.inc({ source_type: sourceType, reason });
  }

  recordDetailTasksCreated(sourceType: string, count: number): void {
    this.listPageDetailTasksCreated.inc({ source_type: sourceType }, count);
  }

  resetQueueDepth(): void {
    this.queueDepthGauge.reset();
  }

  setQueueDepth(queueName: string, sourceType: string, status: string, count: number): void {
    this.queueDepthGauge.set(
      { queue_name: queueName, source_type: sourceType, status },
      count,
    );
  }
}
