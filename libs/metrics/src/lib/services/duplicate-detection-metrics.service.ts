import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  DUPLICATE_PAIRS_DETECTED_TOTAL,
  DUPLICATE_AUTO_MERGED_TOTAL,
  DUPLICATE_PENDING_REVIEW_TOTAL,
  DUPLICATE_SKIPPED_TOTAL,
  DUPLICATE_DETECTION_DURATION_SECONDS,
  DUPLICATE_SIMILARITY_SCORE,
} from '../metric-names';

@Injectable()
export class DuplicateDetectionMetricsService {
  private readonly pairsDetectedCounter: client.Counter<string>;
  private readonly autoMergedCounter: client.Counter<string>;
  private readonly pendingReviewCounter: client.Counter<string>;
  private readonly skippedCounter: client.Counter<string>;
  private readonly detectionDurationHistogram: client.Histogram<string>;
  private readonly similarityScoreHistogram: client.Histogram<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.pairsDetectedCounter = new client.Counter({
      name: DUPLICATE_PAIRS_DETECTED_TOTAL,
      help: 'Total duplicate pairs detected',
      labelNames: ['category'],
      registers: [this.prometheusService.register],
    });

    this.autoMergedCounter = new client.Counter({
      name: DUPLICATE_AUTO_MERGED_TOTAL,
      help: 'Total duplicate pairs auto-merged',
      labelNames: ['category'],
      registers: [this.prometheusService.register],
    });

    this.pendingReviewCounter = new client.Counter({
      name: DUPLICATE_PENDING_REVIEW_TOTAL,
      help: 'Total duplicate pairs sent for review',
      labelNames: ['category'],
      registers: [this.prometheusService.register],
    });

    this.skippedCounter = new client.Counter({
      name: DUPLICATE_SKIPPED_TOTAL,
      help: 'Total duplicate pairs skipped',
      labelNames: ['category', 'reason'],
      registers: [this.prometheusService.register],
    });

    this.detectionDurationHistogram = new client.Histogram({
      name: DUPLICATE_DETECTION_DURATION_SECONDS,
      help: 'Duration of duplicate detection per category',
      labelNames: ['category'],
      buckets: [1, 5, 10, 30, 60, 120, 300],
      registers: [this.prometheusService.register],
    });

    this.similarityScoreHistogram = new client.Histogram({
      name: DUPLICATE_SIMILARITY_SCORE,
      help: 'Similarity score distribution of detected pairs',
      labelNames: ['category', 'decision'],
      buckets: [40, 50, 60, 70, 80, 90, 95, 100],
      registers: [this.prometheusService.register],
    });
  }

  public pairDetected(category: string): void {
    this.pairsDetectedCounter.inc({ category });
  }

  public autoMerged(category: string): void {
    this.autoMergedCounter.inc({ category });
  }

  public pendingReview(category: string): void {
    this.pendingReviewCounter.inc({ category });
  }

  public skipped(category: string, reason: string): void {
    this.skippedCounter.inc({ category, reason });
  }

  public observeDetectionDuration(category: string, durationSeconds: number): void {
    this.detectionDurationHistogram.observe({ category }, durationSeconds);
  }

  public observeSimilarityScore(category: string, decision: string, score: number): void {
    this.similarityScoreHistogram.observe({ category, decision }, score);
  }
}
