import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  PIPELINE_RELEVANCE_SCORE,
  PIPELINE_RELEVANCE_OUTCOME_TOTAL,
  PIPELINE_MODERATION_OUTCOME_TOTAL,
  PIPELINE_THREAD_COST,
  PIPELINE_SUBTREE_EXTRACTION_TOTAL,
  PIPELINE_SUBTREE_EXTRACTION_DURATION_SECONDS,
  PIPELINE_SUBTREE_EXTRACTION_PLAN_NODES,
  PIPELINE_SUBTREE_EXTRACTION_MISS_RATE,
  PIPELINE_SUBTREE_EXTRACTION_RETRY_TOTAL,
  PIPELINE_SUBTREE_EXTRACTION_COST,
  PIPELINE_SUBTREE_VALIDATION_TOTAL,
  PIPELINE_SUBTREE_VALIDATION_DURATION_SECONDS,
  PIPELINE_VALIDATION_OUTCOME_TOTAL,
  PIPELINE_VALIDATION_FAST_PATH_TOTAL,
  PIPELINE_SUBTREE_VALIDATION_COST,
  PIPELINE_OP_SUMMARIZATION_TOTAL,
  PIPELINE_THREAD_SUBTREE_COUNT,
  PIPELINE_THREAD_PHASE_DURATION_SECONDS,
  PIPELINE_THREAD_PROCESSING_DURATION_SECONDS,
  PIPELINE_REGISTRY_PRODUCT_COUNT,
  PIPELINE_REGISTRY_CHEAT_SHEET_CHARS,
  PIPELINE_DEFERRED_RESOLUTION_TOTAL,
  PIPELINE_DEFERRED_RESOLUTION_DURATION_SECONDS,
  PIPELINE_DEFERRED_RESOLUTION_BATCH_SIZE,
  PIPELINE_DEFERRED_REFS_CLASSIFIED_TOTAL,
  PRODUCT_RESOLUTION_OUTCOME_TOTAL,
} from '../metric-names';

@Injectable()
export class PipelineMetricsService {
  // ── Existing metrics ────────────────────────────────────────────────────────
  private readonly relevanceScore: client.Histogram<string>;
  private readonly relevanceOutcome: client.Counter<string>;
  private readonly moderationOutcome: client.Counter<string>;
  private readonly threadCost: client.Histogram<string>;

  // ── Batched pipeline metrics ────────────────────────────────────────────────
  private readonly subtreeExtractionTotal: client.Counter<string>;
  private readonly subtreeExtractionDuration: client.Histogram<string>;
  private readonly subtreeExtractionPlanNodes: client.Histogram<string>;
  private readonly subtreeExtractionMissRate: client.Histogram<string>;
  private readonly subtreeExtractionRetryTotal: client.Counter<string>;
  private readonly subtreeExtractionCost: client.Histogram<string>;
  private readonly subtreeValidationTotal: client.Counter<string>;
  private readonly subtreeValidationDuration: client.Histogram<string>;
  private readonly validationOutcome: client.Counter<string>;
  private readonly validationFastPathTotal: client.Counter<string>;
  private readonly subtreeValidationCost: client.Histogram<string>;
  private readonly opSummarizationTotal: client.Counter<string>;
  private readonly threadSubtreeCount: client.Histogram<string>;
  private readonly threadPhaseDuration: client.Histogram<string>;
  private readonly threadProcessingDuration: client.Histogram<string>;
  private readonly registryProductCount: client.Histogram<string>;
  private readonly registryCheatSheetChars: client.Histogram<string>;

  // ── Resolution outcome metrics ────────────────────────────────────────────
  private readonly resolutionOutcome: client.Counter<string>;

  // ── Deferred resolution metrics ───────────────────────────────────────────
  private readonly deferredResolutionTotal: client.Counter<string>;
  private readonly deferredResolutionDuration: client.Histogram<string>;
  private readonly deferredResolutionBatchSize: client.Histogram<string>;
  private readonly deferredRefsClassifiedTotal: client.Counter<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    const reg = [this.prometheusService.register];

    // ── Existing metrics ──────────────────────────────────────────────────

    this.relevanceScore = new client.Histogram({
      name: PIPELINE_RELEVANCE_SCORE,
      help: 'Distribution of comment relevance scores',
      labelNames: ['category'],
      buckets: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      registers: reg,
    });

    this.relevanceOutcome = new client.Counter({
      name: PIPELINE_RELEVANCE_OUTCOME_TOTAL,
      help: 'Total comments by relevance outcome',
      labelNames: ['outcome'],
      registers: reg,
    });

    this.moderationOutcome = new client.Counter({
      name: PIPELINE_MODERATION_OUTCOME_TOTAL,
      help: 'Total comments by moderation outcome',
      labelNames: ['outcome'],
      registers: reg,
    });

    this.threadCost = new client.Histogram({
      name: PIPELINE_THREAD_COST,
      help: 'Total LLM cost per thread in dollars',
      labelNames: [],
      buckets: [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.75, 1.0],
      registers: reg,
    });

    // ── Batched pipeline: Subtree Extraction ──────────────────────────────

    this.subtreeExtractionTotal = new client.Counter({
      name: PIPELINE_SUBTREE_EXTRACTION_TOTAL,
      help: 'Total subtree extraction LLM calls',
      labelNames: ['model', 'status'],
      registers: reg,
    });

    this.subtreeExtractionDuration = new client.Histogram({
      name: PIPELINE_SUBTREE_EXTRACTION_DURATION_SECONDS,
      help: 'Subtree extraction LLM call duration in seconds',
      labelNames: ['model'],
      buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
      registers: reg,
    });

    this.subtreeExtractionPlanNodes = new client.Histogram({
      name: PIPELINE_SUBTREE_EXTRACTION_PLAN_NODES,
      help: 'Number of PLAN nodes per extraction LLM call',
      labelNames: [],
      buckets: [1, 2, 3, 5, 7, 10, 12, 15],
      registers: reg,
    });

    this.subtreeExtractionMissRate = new client.Histogram({
      name: PIPELINE_SUBTREE_EXTRACTION_MISS_RATE,
      help: 'Extraction miss rate (proportion of PLAN nodes with zero mentions)',
      labelNames: [],
      buckets: [0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 1.0],
      registers: reg,
    });

    this.subtreeExtractionRetryTotal = new client.Counter({
      name: PIPELINE_SUBTREE_EXTRACTION_RETRY_TOTAL,
      help: 'Total extraction retries triggered by high miss rate',
      labelNames: [],
      registers: reg,
    });

    this.subtreeExtractionCost = new client.Histogram({
      name: PIPELINE_SUBTREE_EXTRACTION_COST,
      help: 'Cost per subtree extraction LLM call in USD',
      labelNames: ['model'],
      buckets: [0.001, 0.005, 0.01, 0.02, 0.05, 0.10, 0.20],
      registers: reg,
    });

    // ── Batched pipeline: Subtree Validation ──────────────────────────────

    this.subtreeValidationTotal = new client.Counter({
      name: PIPELINE_SUBTREE_VALIDATION_TOTAL,
      help: 'Total subtree validation LLM calls',
      labelNames: ['model', 'status'],
      registers: reg,
    });

    this.subtreeValidationDuration = new client.Histogram({
      name: PIPELINE_SUBTREE_VALIDATION_DURATION_SECONDS,
      help: 'Subtree validation LLM call duration in seconds',
      labelNames: ['model'],
      buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
      registers: reg,
    });

    this.validationOutcome = new client.Counter({
      name: PIPELINE_VALIDATION_OUTCOME_TOTAL,
      help: 'Total comments by validation outcome',
      labelNames: ['outcome'],
      registers: reg,
    });

    this.validationFastPathTotal = new client.Counter({
      name: PIPELINE_VALIDATION_FAST_PATH_TOTAL,
      help: 'Total comments auto-approved via fast-path (no LLM call)',
      labelNames: [],
      registers: reg,
    });

    this.subtreeValidationCost = new client.Histogram({
      name: PIPELINE_SUBTREE_VALIDATION_COST,
      help: 'Cost per subtree validation LLM call in USD',
      labelNames: ['model'],
      buckets: [0.001, 0.005, 0.01, 0.02, 0.05, 0.10, 0.20],
      registers: reg,
    });

    // ── Batched pipeline: OP & Thread ─────────────────────────────────────

    this.opSummarizationTotal = new client.Counter({
      name: PIPELINE_OP_SUMMARIZATION_TOTAL,
      help: 'Total OP summarization decisions',
      labelNames: ['action'],
      registers: reg,
    });

    this.threadSubtreeCount = new client.Histogram({
      name: PIPELINE_THREAD_SUBTREE_COUNT,
      help: 'Number of subtrees built per thread',
      labelNames: [],
      buckets: [1, 2, 3, 5, 7, 10, 15, 20],
      registers: reg,
    });

    this.threadPhaseDuration = new client.Histogram({
      name: PIPELINE_THREAD_PHASE_DURATION_SECONDS,
      help: 'Duration of each processing phase within a thread',
      labelNames: ['phase'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
      registers: reg,
    });

    this.threadProcessingDuration = new client.Histogram({
      name: PIPELINE_THREAD_PROCESSING_DURATION_SECONDS,
      help: 'Total thread processing duration in seconds',
      labelNames: [],
      buckets: [1, 5, 10, 30, 60, 120, 300, 600],
      registers: reg,
    });

    // ── Batched pipeline: Registry ────────────────────────────────────────

    this.registryProductCount = new client.Histogram({
      name: PIPELINE_REGISTRY_PRODUCT_COUNT,
      help: 'Total products in registry at end of thread processing',
      labelNames: [],
      buckets: [1, 5, 10, 20, 30, 50, 75, 100],
      registers: reg,
    });

    this.registryCheatSheetChars = new client.Histogram({
      name: PIPELINE_REGISTRY_CHEAT_SHEET_CHARS,
      help: 'Cheat sheet character count at end of thread processing',
      labelNames: [],
      buckets: [100, 500, 1000, 1500, 2000, 2500, 3000],
      registers: reg,
    });

    // ── Resolution outcome ───────────────────────────────────────────────

    this.resolutionOutcome = new client.Counter({
      name: PRODUCT_RESOLUTION_OUTCOME_TOTAL,
      help: 'Total product reference resolutions by outcome, web search usage, and registry hit',
      labelNames: ['outcome', 'used_web_search', 'registry_hit'],
      registers: reg,
    });

    // ── Deferred resolution ─────────────────────────────────────────────

    this.deferredResolutionTotal = new client.Counter({
      name: PIPELINE_DEFERRED_RESOLUTION_TOTAL,
      help: 'Total deferred references resolved retroactively',
      labelNames: ['outcome'],
      registers: reg,
    });

    this.deferredResolutionDuration = new client.Histogram({
      name: PIPELINE_DEFERRED_RESOLUTION_DURATION_SECONDS,
      help: 'Duration of deferred resolution batch processing in seconds',
      labelNames: [],
      buckets: [1, 5, 10, 30, 60, 120, 300, 600],
      registers: reg,
    });

    this.deferredResolutionBatchSize = new client.Histogram({
      name: PIPELINE_DEFERRED_RESOLUTION_BATCH_SIZE,
      help: 'Number of deferred references per batch',
      labelNames: [],
      buckets: [1, 5, 10, 20, 30, 50, 75, 100],
      registers: reg,
    });

    this.deferredRefsClassifiedTotal = new client.Counter({
      name: PIPELINE_DEFERRED_REFS_CLASSIFIED_TOTAL,
      help: 'Total product references classified during extraction',
      labelNames: ['classification'],
      registers: reg,
    });
  }

  // ── Relevance ──────────────────────────────────────────────────────────────

  recordRelevanceScore(score: number, category?: string): void {
    this.relevanceScore.observe({ category: category ?? 'unknown' }, score);
  }

  recordRelevanceOutcome(outcome: 'passed' | 'skipped'): void {
    this.relevanceOutcome.inc({ outcome });
  }

  // ── Moderation ─────────────────────────────────────────────────────────────

  recordModerationOutcome(
    outcome: 'approved' | 'in_review' | 'deleted',
  ): void {
    this.moderationOutcome.inc({ outcome });
  }

  // ── Thread Cost ────────────────────────────────────────────────────────────

  recordThreadCost(cost: number): void {
    this.threadCost.observe(cost);
  }

  // ── Batched Pipeline: Subtree Extraction ───────────────────────────────────

  recordSubtreeExtraction(
    model: string,
    status: 'success' | 'error' | 'retry',
  ): void {
    this.subtreeExtractionTotal.inc({ model, status });
  }

  recordSubtreeExtractionDuration(model: string, seconds: number): void {
    this.subtreeExtractionDuration.observe({ model }, seconds);
  }

  recordSubtreeExtractionPlanNodes(count: number): void {
    this.subtreeExtractionPlanNodes.observe(count);
  }

  recordSubtreeExtractionMissRate(rate: number): void {
    this.subtreeExtractionMissRate.observe(rate);
  }

  recordSubtreeExtractionRetry(): void {
    this.subtreeExtractionRetryTotal.inc();
  }

  recordSubtreeExtractionCost(model: string, cost: number): void {
    this.subtreeExtractionCost.observe({ model }, cost);
  }

  // ── Batched Pipeline: Subtree Validation ───────────────────────────────────

  recordSubtreeValidation(
    model: string,
    status: 'success' | 'error',
  ): void {
    this.subtreeValidationTotal.inc({ model, status });
  }

  recordSubtreeValidationDuration(model: string, seconds: number): void {
    this.subtreeValidationDuration.observe({ model }, seconds);
  }

  recordValidationOutcome(
    outcome: 'approved' | 'in_review' | 'deleted',
  ): void {
    this.validationOutcome.inc({ outcome });
  }

  recordValidationFastPath(): void {
    this.validationFastPathTotal.inc();
  }

  recordSubtreeValidationCost(model: string, cost: number): void {
    this.subtreeValidationCost.observe({ model }, cost);
  }

  // ── Batched Pipeline: OP & Thread ──────────────────────────────────────────

  recordOpSummarization(action: 'summarized' | 'skipped'): void {
    this.opSummarizationTotal.inc({ action });
  }

  recordThreadSubtreeCount(count: number): void {
    this.threadSubtreeCount.observe(count);
  }

  recordThreadPhaseDuration(phase: string, seconds: number): void {
    this.threadPhaseDuration.observe({ phase }, seconds);
  }

  recordThreadProcessingDuration(seconds: number): void {
    this.threadProcessingDuration.observe(seconds);
  }

  // ── Batched Pipeline: Registry ─────────────────────────────────────────────

  recordRegistryProductCount(count: number): void {
    this.registryProductCount.observe(count);
  }

  recordRegistryCheatSheetChars(chars: number): void {
    this.registryCheatSheetChars.observe(chars);
  }

  // ── Resolution Outcome ──────────────────────────────────────────────────

  recordResolutionOutcome(
    outcome: 'resolved' | 'unresolved' | 'error',
    usedWebSearch: boolean,
    registryHit: boolean,
  ): void {
    this.resolutionOutcome.inc({
      outcome,
      used_web_search: String(usedWebSearch),
      registry_hit: String(registryHit),
    });
  }

  // ── Deferred Resolution ─────────────────────────────────────────────────

  recordDeferredResolution(
    outcome: 'resolved' | 'unresolved' | 'error',
  ): void {
    this.deferredResolutionTotal.inc({ outcome });
  }

  recordDeferredResolutionDuration(seconds: number): void {
    this.deferredResolutionDuration.observe(seconds);
  }

  recordDeferredResolutionBatchSize(count: number): void {
    this.deferredResolutionBatchSize.observe(count);
  }

  recordDeferredRefClassified(
    classification: 'actionable' | 'deferred' | 'deferred_no_category',
  ): void {
    this.deferredRefsClassifiedTotal.inc({ classification });
  }
}
