import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  ZYTE_SCRAPE_DURATION_SECONDS,
  ZYTE_SCRAPE_TOTAL,
} from '../metric-names';

@Injectable()
export class ZyteMetricsService {
  private readonly scrapeTotal: client.Counter<string>;
  private readonly scrapeDuration: client.Histogram<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.scrapeTotal = new client.Counter({
      name: ZYTE_SCRAPE_TOTAL,
      help: 'Total Zyte HTTP scrape outcomes',
      labelNames: ['status'],
      registers: [this.prometheusService.register],
    });

    this.scrapeDuration = new client.Histogram({
      name: ZYTE_SCRAPE_DURATION_SECONDS,
      help: 'Zyte HTTP scrape latency in seconds',
      buckets: [0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.prometheusService.register],
    });
  }

  scrapeCompleted(): void {
    this.scrapeTotal.inc({ status: 'success' });
  }

  scrapeFailed(): void {
    this.scrapeTotal.inc({ status: 'error' });
  }

  recordScrapeDuration(durationSeconds: number): void {
    this.scrapeDuration.observe(durationSeconds);
  }
}
