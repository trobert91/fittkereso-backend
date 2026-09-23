import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  NATIVE_SCRAPE_DURATION_SECONDS,
  NATIVE_SCRAPE_TOTAL,
} from '../metric-names';

/**
 * Plain-HTTP fetch metrics, deliberately a SEPARATE series from Zyte's.
 *
 * Zyte costs money per request and this does not, so one combined "fetches"
 * counter would hide the only number that matters when a shop moves from
 * scraping to a feed: whether its paid request count actually went to zero.
 * Two series make that a query rather than an inference — and they also catch
 * the failure mode that would otherwise be invisible, a feed accidentally
 * routed through the paid fetcher, which works perfectly and quietly bills.
 */
@Injectable()
export class NativeScraperMetricsService {
  private readonly fetchTotal: client.Counter<string>;
  private readonly fetchDuration: client.Histogram<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.fetchTotal = new client.Counter({
      name: NATIVE_SCRAPE_TOTAL,
      help: 'Total native (unpaid) HTTP fetch outcomes',
      labelNames: ['status'],
      registers: [this.prometheusService.register],
    });

    this.fetchDuration = new client.Histogram({
      name: NATIVE_SCRAPE_DURATION_SECONDS,
      help: 'Native HTTP fetch latency in seconds, to first byte',
      // Wider at the top than Zyte's: this path pulls whole feeds, and
      // speedbike's is 26 MB today.
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
      registers: [this.prometheusService.register],
    });
  }

  fetchCompleted(): void {
    this.fetchTotal.inc({ status: 'success' });
  }

  fetchFailed(): void {
    this.fetchTotal.inc({ status: 'error' });
  }

  recordFetchDuration(durationSeconds: number): void {
    this.fetchDuration.observe(durationSeconds);
  }
}
