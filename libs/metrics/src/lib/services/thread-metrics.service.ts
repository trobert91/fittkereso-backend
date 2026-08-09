import { Injectable } from "@nestjs/common";
import * as client from "prom-client";
import { PrometheusService } from "../prometheus.service";
import { ThreadPlatform } from "@ebike-backend/database";
import {
  THREAD_CREATED as NEW_THREAD_CREATED,
  THREAD_PREPROCESSED,
  THREAD_PROCESSING_STARTED_TOTAL,
  THREAD_CATEGORY_NOT_FOUND,
  THREAD_RELEVANCE,
  THREAD_RELEVANCE_CALCULATION_TOTAL,
  THREAD_RELEVANCE_CALCULATION_DURATION_SECONDS,
} from "../metric-names";

@Injectable()
export class ThreadMetricsService {
  private readonly processingStartedCounter: client.Counter<string>;
  private readonly createdCounter: client.Counter<string>;
  private readonly preProcessedCounter: client.Counter<string>;
  private readonly categoryNotFoundCounter: client.Counter<string>;
  private readonly relevanceSummary: client.Summary<string>;
  private readonly relevanceCalculationCounter: client.Counter<string>;
  private readonly relevanceCalculationDuration: client.Histogram<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.processingStartedCounter = new client.Counter({
      name: THREAD_PROCESSING_STARTED_TOTAL,
      help: "Total number of thread processing starts",
      labelNames: ["source"],
      registers: [this.prometheusService.register],
    });

    this.createdCounter = new client.Counter({
      name: NEW_THREAD_CREATED,
      help: "Total number of new threads created",
      labelNames: ["source"],
      registers: [this.prometheusService.register],
    });

    this.preProcessedCounter = new client.Counter({
      name: THREAD_PREPROCESSED,
      help: "Total number of new threads preprocessed",
      labelNames: ["source"],
      registers: [this.prometheusService.register],
    });

    this.categoryNotFoundCounter = new client.Counter({
      name: THREAD_CATEGORY_NOT_FOUND,
      help: "Total number of threads with category not found",
      labelNames: ["source"],
      registers: [this.prometheusService.register],
    });

    this.relevanceSummary = new client.Summary({
      name: THREAD_RELEVANCE,
      help: "Thread relevance score",
      labelNames: ["source"],
      registers: [this.prometheusService.register],
    });

    this.relevanceCalculationCounter = new client.Counter({
      name: THREAD_RELEVANCE_CALCULATION_TOTAL,
      help: "Total number of thread relevance calculations",
      labelNames: ["result"],
      registers: [this.prometheusService.register],
    });

    this.relevanceCalculationDuration = new client.Histogram({
      name: THREAD_RELEVANCE_CALCULATION_DURATION_SECONDS,
      help: "Duration of thread relevance calculation in seconds",
      buckets: [0.5, 1, 2, 5, 10, 20],
      registers: [this.prometheusService.register],
    });
  }

  created(source: ThreadPlatform): void {
    this.createdCounter.inc({ source });
  }

  preProcessed(source: ThreadPlatform): void {
    this.preProcessedCounter.inc({ source });
  }

  processingStarted(source: ThreadPlatform): void {
    this.processingStartedCounter.inc({ source });
  }

  categoryNotFound(source: ThreadPlatform): void {
    this.categoryNotFoundCounter.inc({ source });
  }

  relevanceCalculated(source: ThreadPlatform, relevance: number): void {
    this.relevanceSummary.observe({ source }, relevance);
  }

  relevanceCalculationCompleted(result: "passed" | "skipped"): void {
    this.relevanceCalculationCounter.inc({ result });
  }

  relevanceCalculationDurationObserved(durationSeconds: number): void {
    this.relevanceCalculationDuration.observe(durationSeconds);
  }
}
