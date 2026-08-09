import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  AI_CHAT_COMPLETION_TOTAL,
  AI_CHAT_COMPLETION_DURATION_SECONDS,
  AI_CHAT_COMPLETION_TOKENS_TOTAL,
} from '../metric-names';

@Injectable()
export class AiMetricsService {
  private readonly completionCounter: client.Counter<string>;
  private readonly durationHistogram: client.Histogram<string>;
  private readonly tokensCounter: client.Counter<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.completionCounter = new client.Counter({
      name: AI_CHAT_COMPLETION_TOTAL,
      help: 'Total number of AI chat completions',
      labelNames: ['provider', 'model', 'cost_label', 'status'],
      registers: [this.prometheusService.register],
    });

    this.durationHistogram = new client.Histogram({
      name: AI_CHAT_COMPLETION_DURATION_SECONDS,
      help: 'Duration of AI chat completions in seconds',
      labelNames: ['provider', 'model', 'cost_label'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.prometheusService.register],
    });

    this.tokensCounter = new client.Counter({
      name: AI_CHAT_COMPLETION_TOKENS_TOTAL,
      help: 'Total tokens used in AI chat completions',
      labelNames: ['provider', 'model', 'cost_label', 'token_type'],
      registers: [this.prometheusService.register],
    });
  }

  recordCompletion(
    provider: string,
    model: string,
    costLabel: string,
    durationSeconds: number,
    promptTokens: number,
    completionTokens: number,
    status: 'success' | 'error',
  ): void {
    const labels = { provider, model, cost_label: costLabel };

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
  }
}
