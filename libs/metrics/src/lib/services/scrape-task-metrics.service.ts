import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  SCRAPE_TASK_STARTED_TOTAL,
  SCRAPE_TASK_FINISHED_TOTAL,
  SCRAPE_TASK_FAILED_TOTAL,
  SCRAPE_TASK_DURATION_SECONDS,
} from '../metric-names';
import { ProductSourceType } from '@fittkereso-backend/database';

@Injectable()
export class ScrapeTaskMetricsService {
  private readonly taskStartedCounter: client.Counter<string>;
  private readonly taskFinishedCounter: client.Counter<string>;
  private readonly taskFailedCounter: client.Counter<string>;
  private readonly taskDurationSummary: client.Summary<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.taskStartedCounter = new client.Counter({
      name: SCRAPE_TASK_STARTED_TOTAL,
      help: 'Total number of scrape task processing starts',
      labelNames: ['queue_name', 'source_type'],
      registers: [this.prometheusService.register],
    });

    this.taskFinishedCounter = new client.Counter({
      name: SCRAPE_TASK_FINISHED_TOTAL,
      help: 'Total number of scrape task processing finishes',
      labelNames: ['queue_name', 'source_type'],
      registers: [this.prometheusService.register],
    });

    this.taskFailedCounter = new client.Counter({
      name: SCRAPE_TASK_FAILED_TOTAL,
      help: 'Total number of scrape task processing failures',
      labelNames: ['queue_name', 'source_type'],
      registers: [this.prometheusService.register],
    });

    this.taskDurationSummary = new client.Summary({
      name: SCRAPE_TASK_DURATION_SECONDS,
      help: 'Scrape task processing duration in seconds',
      labelNames: ['queue_name', 'source_type', 'status'], // status: finished or failed
      percentiles: [0.5, 0.9, 0.99],
      registers: [this.prometheusService.register],
    });
  }

  public taskStarted(queueName: string, type: ProductSourceType): void {
    this.taskStartedCounter.inc({ queue_name: queueName, source_type: type });
  }

  public taskFinished(queueName: string, type: ProductSourceType): void {
    this.taskFinishedCounter.inc({
      queue_name: queueName,
      source_type: type,
    });
  }

  public taskFailed(queueName: string, type: ProductSourceType): void {
    this.taskFailedCounter.inc({
      queue_name: queueName,
      source_type: type,
    });
  }

  public recordTaskDuration(
    queueName: string,
    type: ProductSourceType,
    status: 'finished' | 'failed',
    durationSeconds: number,
  ): void {
    this.taskDurationSummary.observe(
      { queue_name: queueName, source_type: type, status },
      durationSeconds,
    );
  }
}
