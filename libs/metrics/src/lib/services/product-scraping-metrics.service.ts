import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  DETAIL_EXTRACTION_OUTCOME_TOTAL,
  DETAIL_EXTRACTION_SKIP_REASON_TOTAL,
  DETAIL_SCRAPE_DURATION_SECONDS,
  DETAIL_EXTRACTION_DURATION_SECONDS,
} from '../metric-names';

@Injectable()
export class ProductScrapingMetricsService {
  private readonly extractionOutcome: client.Counter<string>;
  private readonly extractionSkipReason: client.Counter<string>;
  private readonly scrapeDuration: client.Histogram<string>;
  private readonly extractionDuration: client.Histogram<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.extractionOutcome = new client.Counter({
      name: DETAIL_EXTRACTION_OUTCOME_TOTAL,
      help: 'Detail page extraction outcomes',
      labelNames: ['source_type', 'outcome'],
      registers: [this.prometheusService.register],
    });

    this.extractionSkipReason = new client.Counter({
      name: DETAIL_EXTRACTION_SKIP_REASON_TOTAL,
      help: 'Reasons detail page extraction was skipped',
      labelNames: ['source_type', 'reason'],
      registers: [this.prometheusService.register],
    });

    this.scrapeDuration = new client.Histogram({
      name: DETAIL_SCRAPE_DURATION_SECONDS,
      help: 'Full detail scrape pipeline duration (fetch + extract + update)',
      labelNames: ['source_type'],
      buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
      registers: [this.prometheusService.register],
    });

    this.extractionDuration = new client.Histogram({
      name: DETAIL_EXTRACTION_DURATION_SECONDS,
      help: 'Detail page extraction duration (HTML parse + spec extract + translate)',
      labelNames: ['source_type'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 20],
      registers: [this.prometheusService.register],
    });
  }

  recordExtractionOutcome(sourceType: string, outcome: string): void {
    this.extractionOutcome.inc({ source_type: sourceType, outcome });
  }

  recordExtractionSkipReason(sourceType: string, reason: string): void {
    this.extractionSkipReason.inc({ source_type: sourceType, reason });
  }

  recordScrapeDuration(sourceType: string, durationSeconds: number): void {
    this.scrapeDuration.observe({ source_type: sourceType }, durationSeconds);
  }

  recordExtractionDuration(sourceType: string, durationSeconds: number): void {
    this.extractionDuration.observe(
      { source_type: sourceType },
      durationSeconds,
    );
  }
}
