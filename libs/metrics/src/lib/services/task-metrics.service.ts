import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  TASK_STARTED_TOTAL,
  TASK_FINISHED_TOTAL,
  TASK_FAILED_TOTAL,
  TASK_DURATION_SECONDS,
} from '../metric-names';

@Injectable()
export class TaskMetricsService {
  private readonly taskStartedCounter: client.Counter<string>;
  private readonly taskFinishedCounter: client.Counter<string>;
  private readonly taskFailedCounter: client.Counter<string>;
  private readonly taskDurationSummary: client.Summary<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.taskStartedCounter = new client.Counter({
      name: TASK_STARTED_TOTAL,
      help: 'Total number of task processing starts',
      labelNames: ['queue_name'],
      registers: [this.prometheusService.register],
    });

    this.taskFinishedCounter = new client.Counter({
      name: TASK_FINISHED_TOTAL,
      help: 'Total number of task processing finishes',
      labelNames: ['queue_name'],
      registers: [this.prometheusService.register],
    });

    this.taskFailedCounter = new client.Counter({
      name: TASK_FAILED_TOTAL,
      help: 'Total number of task processing failures',
      labelNames: ['queue_name'],
      registers: [this.prometheusService.register],
    });

    this.taskDurationSummary = new client.Summary({
      name: TASK_DURATION_SECONDS,
      help: 'Task processing duration in seconds',
      labelNames: ['queue_name', 'status'], // status: finished or failed
      percentiles: [0.5, 0.9, 0.99],
      registers: [this.prometheusService.register],
    });
  }

  public taskStarted(queueName: string): void {
    this.taskStartedCounter.inc({ queue_name: queueName });
  }

  public taskFinished(queueName: string): void {
    this.taskFinishedCounter.inc({
      queue_name: queueName,
    });
  }

  public taskFailed(queueName: string): void {
    this.taskFailedCounter.inc({
      queue_name: queueName,
    });
  }

  public recordTaskDuration(
    queueName: string,
    status: 'finished' | 'failed',
    durationSeconds: number,
  ): void {
    this.taskDurationSummary.observe(
      { queue_name: queueName, status },
      durationSeconds,
    );
  }
}
