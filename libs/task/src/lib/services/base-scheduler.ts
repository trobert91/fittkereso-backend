import { CustomLogger } from '@fittkereso-backend/logger';
import { SchedulerMetricsService } from '@fittkereso-backend/metrics';

export abstract class BaseScheduler {
  protected readonly logger: CustomLogger;
  constructor(
    protected readonly schedulerName: string,
    protected readonly metricsService: SchedulerMetricsService,
  ) {
    this.logger = new CustomLogger(schedulerName);
  }

  async schedule(scheduleFn: () => Promise<void>): Promise<void> {
    this.metricsService.schedulerStarted(this.schedulerName);

    try {
      await scheduleFn();

      this.metricsService.schedulerFinished(this.schedulerName);
    } catch (error: any) {
      this.metricsService.schedulerFailed(this.schedulerName);

      this.logger.error(
        `Error occurred during scheduling in ${this.schedulerName}.`,
        error,
      );
    }
  }
}
