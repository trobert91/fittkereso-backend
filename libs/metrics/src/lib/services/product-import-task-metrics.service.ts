import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  PRODUCT_IMPORT_TASK_STARTED_TOTAL,
  PRODUCT_IMPORT_TASK_FINISHED_TOTAL,
  PRODUCT_IMPORT_TASK_FAILED_TOTAL,
  PRODUCT_IMPORT_TASK_DURATION_SECONDS,
  PRODUCT_IMPORT_TASK_IN_FLIGHT,
} from '../metric-names';

@Injectable()
export class ProductImportTaskMetricsService {
  private readonly taskStartedCounter: client.Counter<string>;
  private readonly taskFinishedCounter: client.Counter<string>;
  private readonly taskFailedCounter: client.Counter<string>;
  private readonly taskDurationSummary: client.Summary<string>;
  private readonly inFlightGauge: client.Gauge<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.inFlightGauge = new client.Gauge({
      name: PRODUCT_IMPORT_TASK_IN_FLIGHT,
      help: 'Import tasks this collector is running right now',
      registers: [this.prometheusService.register],
    });

    this.taskStartedCounter = new client.Counter({
      name: PRODUCT_IMPORT_TASK_STARTED_TOTAL,
      help: 'Total number of import task processing starts',
      labelNames: ['kind', 'source_type'],
      registers: [this.prometheusService.register],
    });

    this.taskFinishedCounter = new client.Counter({
      name: PRODUCT_IMPORT_TASK_FINISHED_TOTAL,
      help: 'Total number of import task processing finishes',
      labelNames: ['kind', 'source_type'],
      registers: [this.prometheusService.register],
    });

    this.taskFailedCounter = new client.Counter({
      name: PRODUCT_IMPORT_TASK_FAILED_TOTAL,
      help: 'Total number of import task processing failures',
      labelNames: ['kind', 'source_type'],
      registers: [this.prometheusService.register],
    });

    this.taskDurationSummary = new client.Summary({
      name: PRODUCT_IMPORT_TASK_DURATION_SECONDS,
      help: 'Import task processing duration in seconds',
      labelNames: ['kind', 'source_type', 'status'], // status: finished or failed
      percentiles: [0.5, 0.9, 0.99],
      registers: [this.prometheusService.register],
    });
  }

  public setInFlight(count: number): void {
    this.inFlightGauge.set(count);
  }

  public taskStarted(kind: string, sourceName: string): void {
    this.taskStartedCounter.inc({
      kind,
      source_type: sourceName,
    });
  }

  public taskFinished(kind: string, sourceName: string): void {
    this.taskFinishedCounter.inc({
      kind,
      source_type: sourceName,
    });
  }

  public taskFailed(kind: string, sourceName: string): void {
    this.taskFailedCounter.inc({
      kind,
      source_type: sourceName,
    });
  }

  public recordTaskDuration(
    kind: string,
    sourceName: string,
    status: 'finished' | 'failed',
    durationSeconds: number,
  ): void {
    this.taskDurationSummary.observe(
      { kind, source_type: sourceName, status },
      durationSeconds,
    );
  }
}
