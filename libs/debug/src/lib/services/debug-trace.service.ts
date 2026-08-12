import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { ProcessingTraceData } from '../models/processing-trace-data';
import { TraceLoggerService } from './trace-logger.service';

export interface RecordTraceInput {
  productId?: string;
  step: string;
  iteration?: number;
  statusBefore: string;
  statusAfter: string;
  durationMs: number;
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cost?: number;
  costLabel?: string;
  data: ProcessingTraceData & {
    llm?: {
      systemPrompt?: string;
      systemPromptHash?: string;
      [key: string]: any;
    };
  };
}

@Injectable()
export class DebugTraceService {
  constructor(
    private readonly traceLogger: TraceLoggerService,
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  async record(input: RecordTraceInput): Promise<void> {
    try {
      if (!this.dynamicConfig.debug?.traceEnabled) {
        return;
      }

      let processedData: any = { ...input.data };

      if (input.data.llm?.systemPrompt) {
        const systemPrompt = input.data.llm.systemPrompt;
        const hash = this.hashSystemPrompt(systemPrompt);

        // Log system prompt as a separate Loki entry
        this.traceLogger.writeSystemPrompt(hash, systemPrompt, input.step);

        const { systemPrompt: _, ...llmWithoutPrompt } = input.data.llm;
        processedData = {
          ...input.data,
          llm: {
            ...llmWithoutPrompt,
            systemPromptHash: hash,
          },
        };
      }

      this.traceLogger.writeTrace({
        productId: input.productId ?? null,
        step: input.step,
        iteration: input.iteration ?? 0,
        statusBefore: input.statusBefore,
        statusAfter: input.statusAfter,
        durationMs: Math.round(input.durationMs),
        model: input.model ?? null,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        cachedTokens: input.cachedTokens ?? null,
        cost: input.cost ?? null,
        costLabel: input.costLabel ?? null,
        data: processedData,
      });
    } catch (error) {
      // Silently fail — trace errors should never break the pipeline
      console.error('Failed to record debug trace:', error);
    }
  }

  private hashSystemPrompt(prompt: string): string {
    const hash = createHash('sha256').update(prompt).digest('hex');
    return hash.substring(0, 12);
  }
}
