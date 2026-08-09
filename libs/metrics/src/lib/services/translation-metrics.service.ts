import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  TRANSLATION_BATCH_DURATION_SECONDS,
  TRANSLATION_BATCH_TOTAL,
  TRANSLATION_ITEMS_TOTAL,
  TRANSLATION_LLM_CALL_DURATION_SECONDS,
  TRANSLATION_LLM_CALL_TOTAL,
  TRANSLATION_LLM_CHUNK_SIZE,
} from '../metric-names';

/**
 * Prometheus metrics for the TranslationService.
 *
 * Tracks batch-level outcomes, per-item resolution source (dictionary / cache /
 * llm / untranslated), and LLM call timing + chunk sizing.
 */
@Injectable()
export class TranslationMetricsService {
  private readonly batchTotal: client.Counter<string>;
  private readonly batchDuration: client.Histogram<string>;
  private readonly itemsTotal: client.Counter<string>;
  private readonly llmCallTotal: client.Counter<string>;
  private readonly llmCallDuration: client.Histogram<string>;
  private readonly llmChunkSize: client.Histogram<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    const registers = [this.prometheusService.register];

    this.batchTotal = new client.Counter({
      name: TRANSLATION_BATCH_TOTAL,
      help: 'Total TranslationService.translateBatch calls by outcome',
      labelNames: ['source_language', 'target_language', 'outcome'],
      registers,
    });

    this.batchDuration = new client.Histogram({
      name: TRANSLATION_BATCH_DURATION_SECONDS,
      help: 'TranslationService.translateBatch wall-clock duration in seconds',
      labelNames: ['source_language', 'target_language'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
      registers,
    });

    this.itemsTotal = new client.Counter({
      name: TRANSLATION_ITEMS_TOTAL,
      help: 'Total unique strings resolved by source (dictionary / cache / llm / untranslated)',
      labelNames: ['source_language', 'target_language', 'resolved_from'],
      registers,
    });

    this.llmCallTotal = new client.Counter({
      name: TRANSLATION_LLM_CALL_TOTAL,
      help: 'Total LLM calls made by the translation service',
      labelNames: ['source_language', 'target_language', 'status'],
      registers,
    });

    this.llmCallDuration = new client.Histogram({
      name: TRANSLATION_LLM_CALL_DURATION_SECONDS,
      help: 'Translation LLM call duration in seconds',
      labelNames: ['source_language', 'target_language'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers,
    });

    this.llmChunkSize = new client.Histogram({
      name: TRANSLATION_LLM_CHUNK_SIZE,
      help: 'Number of items per LLM translation chunk',
      labelNames: ['source_language', 'target_language'],
      buckets: [1, 5, 10, 20, 30, 50, 100, 200],
      registers,
    });
  }

  recordBatch(params: {
    sourceLanguage: string;
    targetLanguage: string;
    outcome: 'success' | 'empty' | 'identity';
    durationSeconds: number;
  }): void {
    const labels = {
      source_language: params.sourceLanguage,
      target_language: params.targetLanguage,
    };
    this.batchTotal.inc({ ...labels, outcome: params.outcome });
    this.batchDuration.observe(labels, params.durationSeconds);
  }

  recordItems(params: {
    sourceLanguage: string;
    targetLanguage: string;
    fromDictionary: number;
    fromCache: number;
    fromLlm: number;
    untranslated: number;
  }): void {
    const labels = {
      source_language: params.sourceLanguage,
      target_language: params.targetLanguage,
    };
    if (params.fromDictionary > 0) {
      this.itemsTotal.inc(
        { ...labels, resolved_from: 'dictionary' },
        params.fromDictionary,
      );
    }
    if (params.fromCache > 0) {
      this.itemsTotal.inc(
        { ...labels, resolved_from: 'cache' },
        params.fromCache,
      );
    }
    if (params.fromLlm > 0) {
      this.itemsTotal.inc(
        { ...labels, resolved_from: 'llm' },
        params.fromLlm,
      );
    }
    if (params.untranslated > 0) {
      this.itemsTotal.inc(
        { ...labels, resolved_from: 'untranslated' },
        params.untranslated,
      );
    }
  }

  recordLlmCall(params: {
    sourceLanguage: string;
    targetLanguage: string;
    chunkSize: number;
    durationSeconds: number;
    status: 'success' | 'error';
  }): void {
    const labels = {
      source_language: params.sourceLanguage,
      target_language: params.targetLanguage,
    };
    this.llmCallTotal.inc({ ...labels, status: params.status });
    if (params.status === 'success') {
      this.llmCallDuration.observe(labels, params.durationSeconds);
      this.llmChunkSize.observe(labels, params.chunkSize);
    }
  }
}
