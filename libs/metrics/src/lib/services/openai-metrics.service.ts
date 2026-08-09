import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  OPENAI_CHAT_COMPLETION_TOTAL,
  OPENAI_CHAT_COMPLETION_DURATION_SECONDS,
  OPENAI_CHAT_COMPLETION_TOKENS_TOTAL,
} from '../metric-names';
import { AiMetricsService } from './ai-metrics.service';

/**
 * @deprecated Prefer AiMetricsService for new code. This class continues to
 * emit the legacy `openai_chat_completion_*` series so existing Grafana
 * dashboards keep working through one release. It also forwards each call
 * to AiMetricsService with provider="openai" so the new provider-agnostic
 * `ai_chat_completion_*` series stays in sync.
 */
@Injectable()
export class OpenAiMetricsService {
  private readonly completionCounter: client.Counter<string>;
  private readonly durationHistogram: client.Histogram<string>;
  private readonly tokensCounter: client.Counter<string>;

  constructor(
    private readonly prometheusService: PrometheusService,
    private readonly aiMetrics: AiMetricsService,
  ) {
    this.completionCounter = new client.Counter({
      name: OPENAI_CHAT_COMPLETION_TOTAL,
      help: 'Total number of OpenAI chat completions (deprecated — use ai_chat_completion_total)',
      labelNames: ['model', 'cost_label', 'status'],
      registers: [this.prometheusService.register],
    });

    this.durationHistogram = new client.Histogram({
      name: OPENAI_CHAT_COMPLETION_DURATION_SECONDS,
      help: 'Duration of OpenAI chat completions in seconds (deprecated — use ai_chat_completion_duration_seconds)',
      labelNames: ['model', 'cost_label'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.prometheusService.register],
    });

    this.tokensCounter = new client.Counter({
      name: OPENAI_CHAT_COMPLETION_TOKENS_TOTAL,
      help: 'Total tokens used in OpenAI chat completions (deprecated — use ai_chat_completion_tokens_total)',
      labelNames: ['model', 'cost_label', 'token_type'],
      registers: [this.prometheusService.register],
    });
  }

  recordCompletion(
    model: string,
    costLabel: string,
    durationSeconds: number,
    promptTokens: number,
    completionTokens: number,
    status: 'success' | 'error',
  ): void {
    const labels = { model, cost_label: costLabel };

    this.completionCounter.inc({ ...labels, status });

    if (status === 'success') {
      this.durationHistogram.observe(labels, durationSeconds);
      this.tokensCounter.inc(
        { ...labels, token_type: 'prompt' },
        promptTokens,
      );
      this.tokensCounter.inc(
        { ...labels, token_type: 'completion' },
        completionTokens,
      );
    }

    this.aiMetrics.recordCompletion(
      'openai',
      model,
      costLabel,
      durationSeconds,
      promptTokens,
      completionTokens,
      status,
    );
  }
}
