import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  SCHEDULER_FAILED_TOTAL,
  SCHEDULER_FINISHED_TOTAL,
  SCHEDULER_STARTED_TOTAL,
} from '../metric-names';

@Injectable()
export class SchedulerMetricsService {
  private readonly schedulerStartedCounter: client.Counter<string>;
  private readonly schedulerFinishedCounter: client.Counter<string>;
  private readonly schedulerFailedCounter: client.Counter<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.schedulerStartedCounter = new client.Counter({
      name: SCHEDULER_STARTED_TOTAL,
      help: 'Total number of scheduler processing starts',
      labelNames: ['scheduler_name'],
      registers: [this.prometheusService.register],
    });

    this.schedulerFinishedCounter = new client.Counter({
      name: SCHEDULER_FINISHED_TOTAL,
      help: 'Total number of scheduler processing finishes',
      labelNames: ['scheduler_name'],
      registers: [this.prometheusService.register],
    });

    this.schedulerFailedCounter = new client.Counter({
      name: SCHEDULER_FAILED_TOTAL,
      help: 'Total number of scheduler processing failures',
      labelNames: ['scheduler_name'],
      registers: [this.prometheusService.register],
    });
  }

  public schedulerStarted(schedulerName: string): void {
    this.schedulerStartedCounter.inc({ scheduler_name: schedulerName });
  }

  public schedulerFinished(schedulerName: string): void {
    this.schedulerFinishedCounter.inc({ scheduler_name: schedulerName });
  }

  public schedulerFailed(schedulerName: string): void {
    this.schedulerFailedCounter.inc({ scheduler_name: schedulerName });
  }
}
