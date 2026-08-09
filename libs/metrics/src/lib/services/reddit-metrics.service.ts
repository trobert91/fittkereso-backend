import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import { REDDIT_SEARCH_QUERY_PROCESSED } from '../metric-names';

@Injectable()
export class RedditMetricsService {
  private readonly searchQueryProcessedCounter: client.Counter<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.searchQueryProcessedCounter = new client.Counter({
      name: REDDIT_SEARCH_QUERY_PROCESSED,
      help: 'Total number of reddit search queries processed',
      labelNames: [],
      registers: [this.prometheusService.register],
    });
  }

  searchQueryProcessed(): void {
    this.searchQueryProcessedCounter.inc();
  }

  newThreadFound(): void {
    this.searchQueryProcessedCounter.inc();
  }
}
