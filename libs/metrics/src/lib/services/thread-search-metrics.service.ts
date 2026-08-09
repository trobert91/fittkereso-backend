import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  THREAD_SEARCH_AVERAGE_RELEVANCE,
  THREAD_SEARCH_BELOW_QUALITY_GATE_TOTAL,
  THREAD_SEARCH_BUDGET_UTILIZATION,
  THREAD_SEARCH_CATEGORIES_SEARCHED_TOTAL,
  THREAD_SEARCH_CYCLE_DURATION_SECONDS,
  THREAD_SEARCH_CYCLE_TOTAL,
  THREAD_SEARCH_DISCOVERED_TOTAL,
  THREAD_SEARCH_DUPLICATES_TOTAL,
  THREAD_SEARCH_DURATION_SECONDS,
  THREAD_SEARCH_EARLY_STOP_TOTAL,
  THREAD_SEARCH_EXECUTED_TOTAL,
  THREAD_SEARCH_PLATFORM_API_DURATION_SECONDS,
  THREAD_SEARCH_PLATFORM_API_ERROR_TOTAL,
  THREAD_SEARCH_REJECTED_TOTAL,
  THREAD_SEARCH_TASKS_CREATED_TOTAL,
} from '../metric-names';

@Injectable()
export class ThreadSearchMetricsService {
  // --- Scheduler metrics ---
  private readonly schedulerCycleTotal: client.Counter<string>;
  private readonly schedulerCycleDuration: client.Histogram<string>;
  private readonly tasksCreatedTotal: client.Counter<string>;
  private readonly categoriesSearchedTotal: client.Counter<string>;
  private readonly budgetUtilization: client.Gauge<string>;

  // --- Execution metrics ---
  private readonly searchExecutedTotal: client.Counter<string>;
  private readonly searchDurationSeconds: client.Histogram<string>;
  private readonly discoveredTotal: client.Counter<string>;
  private readonly duplicatesTotal: client.Counter<string>;
  private readonly rejectedTotal: client.Counter<string>;
  private readonly belowQualityGateTotal: client.Counter<string>;
  private readonly averageRelevance: client.Histogram<string>;
  private readonly earlyStopTotal: client.Counter<string>;

  // --- Platform metrics ---
  private readonly platformApiDurationSeconds: client.Histogram<string>;
  private readonly platformApiErrorTotal: client.Counter<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    const reg = [this.prometheusService.register];

    this.schedulerCycleTotal = new client.Counter({
      name: THREAD_SEARCH_CYCLE_TOTAL,
      help: 'Scheduler cycles completed',
      labelNames: ['status'],
      registers: reg,
    });

    this.schedulerCycleDuration = new client.Histogram({
      name: THREAD_SEARCH_CYCLE_DURATION_SECONDS,
      help: 'Wall-clock time of entire scheduler cycle',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: reg,
    });

    this.tasksCreatedTotal = new client.Counter({
      name: THREAD_SEARCH_TASKS_CREATED_TOTAL,
      help: 'Tasks created per cycle, broken down by category and platform',
      labelNames: ['category_slug', 'platform'],
      registers: reg,
    });

    this.categoriesSearchedTotal = new client.Counter({
      name: THREAD_SEARCH_CATEGORIES_SEARCHED_TOTAL,
      help: 'Number of categories selected per cycle',
      registers: reg,
    });

    this.budgetUtilization = new client.Gauge({
      name: THREAD_SEARCH_BUDGET_UTILIZATION,
      help: 'Ratio of tasks created to budget available (0.0–1.0)',
      registers: reg,
    });

    this.searchExecutedTotal = new client.Counter({
      name: THREAD_SEARCH_EXECUTED_TOTAL,
      help: 'Search executions completed',
      labelNames: ['category_slug', 'platform', 'status'],
      registers: reg,
    });

    this.searchDurationSeconds = new client.Histogram({
      name: THREAD_SEARCH_DURATION_SECONDS,
      help: 'End-to-end execution time per search task',
      labelNames: ['platform'],
      buckets: [0.5, 1, 2, 5, 10, 30, 60],
      registers: reg,
    });

    this.discoveredTotal = new client.Counter({
      name: THREAD_SEARCH_DISCOVERED_TOTAL,
      help: 'New threads that passed all gates and were saved',
      labelNames: ['category_slug', 'platform'],
      registers: reg,
    });

    this.duplicatesTotal = new client.Counter({
      name: THREAD_SEARCH_DUPLICATES_TOTAL,
      help: 'Threads already in the database',
      labelNames: ['category_slug', 'platform'],
      registers: reg,
    });

    this.rejectedTotal = new client.Counter({
      name: THREAD_SEARCH_REJECTED_TOTAL,
      help: 'Threads rejected',
      labelNames: ['category_slug', 'platform', 'reason'],
      registers: reg,
    });

    this.belowQualityGateTotal = new client.Counter({
      name: THREAD_SEARCH_BELOW_QUALITY_GATE_TOTAL,
      help: 'Threads filtered by minScore/minComments',
      labelNames: ['category_slug', 'platform'],
      registers: reg,
    });

    this.averageRelevance = new client.Histogram({
      name: THREAD_SEARCH_AVERAGE_RELEVANCE,
      help: 'Distribution of relevance scores across accepted threads',
      labelNames: ['category_slug'],
      buckets: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      registers: reg,
    });

    this.earlyStopTotal = new client.Counter({
      name: THREAD_SEARCH_EARLY_STOP_TOTAL,
      help: 'Times chunked processing stopped early due to low avg relevance',
      labelNames: ['category_slug'],
      registers: reg,
    });

    this.platformApiDurationSeconds = new client.Histogram({
      name: THREAD_SEARCH_PLATFORM_API_DURATION_SECONDS,
      help: 'Platform API call duration',
      labelNames: ['platform'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: reg,
    });

    this.platformApiErrorTotal = new client.Counter({
      name: THREAD_SEARCH_PLATFORM_API_ERROR_TOTAL,
      help: 'Platform API errors',
      labelNames: ['platform', 'error_type'],
      registers: reg,
    });
  }

  // --- Scheduler ---

  recordSchedulerCycle(status: 'success' | 'error' | 'skipped'): void {
    this.schedulerCycleTotal.inc({ status });
  }

  recordSchedulerCycleDuration(seconds: number): void {
    this.schedulerCycleDuration.observe(seconds);
  }

  recordTasksCreated(categorySlug: string, platform: string, count: number): void {
    this.tasksCreatedTotal.inc({ category_slug: categorySlug, platform }, count);
  }

  recordCategoriesSearched(count: number): void {
    this.categoriesSearchedTotal.inc(count);
  }

  recordBudgetUtilization(ratio: number): void {
    this.budgetUtilization.set(ratio);
  }

  // --- Execution ---

  recordSearchExecuted(categorySlug: string, platform: string, status: 'success' | 'error'): void {
    this.searchExecutedTotal.inc({ category_slug: categorySlug, platform, status });
  }

  recordSearchDuration(platform: string, seconds: number): void {
    this.searchDurationSeconds.observe({ platform }, seconds);
  }

  recordDiscovered(categorySlug: string, platform: string, count: number): void {
    this.discoveredTotal.inc({ category_slug: categorySlug, platform }, count);
  }

  recordDuplicates(categorySlug: string, platform: string, count: number): void {
    this.duplicatesTotal.inc({ category_slug: categorySlug, platform }, count);
  }

  recordRejected(categorySlug: string, platform: string, reason: string, count: number): void {
    this.rejectedTotal.inc({ category_slug: categorySlug, platform, reason }, count);
  }

  recordAverageRelevance(categorySlug: string, relevance: number): void {
    this.averageRelevance.observe({ category_slug: categorySlug }, relevance);
  }

  recordEarlyStop(categorySlug: string): void {
    this.earlyStopTotal.inc({ category_slug: categorySlug });
  }

  // --- Platform ---

  recordPlatformApiDuration(platform: string, seconds: number): void {
    this.platformApiDurationSeconds.observe({ platform }, seconds);
  }

  recordPlatformApiError(platform: string, errorType: string): void {
    this.platformApiErrorTotal.inc({ platform, error_type: errorType });
  }
}
