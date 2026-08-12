import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { CustomLogger } from '@fittkereso-backend/logger';
import { AiMetricsService } from '@fittkereso-backend/metrics';
import {
  AiChatRequest,
  AiChatResponse,
  AiProviderName,
  AiProviderRegistry,
} from '@fittkereso-backend/ai-core';
import { AiCostCalculationService } from './ai-cost-calculation.service';
import { AiSchemaValidatorService } from './ai-schema-validator.service';

@Injectable()
export class AiChatService {
  private readonly logger = new CustomLogger(AiChatService.name);

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly costService: AiCostCalculationService,
    private readonly validator: AiSchemaValidatorService,
    private readonly metricsService: AiMetricsService,
  ) {}

  async createChat(request: AiChatRequest): Promise<AiChatResponse> {
    const startTime = Date.now();
    const chatId = uuidv4();

    const provider = this.registry.resolveChat(request.model);
    const config = provider.getConfig();

    const debugContext = {
      chatId,
      provider: provider.name,
      model: request.model,
      thinking: request.thinking,
      effort: request.effort,
      ...(request.logContext ?? {}),
    };

    if (config.debug) {
      const firstMessageContent = request.messages[0]?.content;
      const preview =
        typeof firstMessageContent === 'string'
          ? firstMessageContent.slice(0, 200)
          : '[multimodal content]';
      this.logger.debug(
        `Creating AI chat [${provider.name}:${request.model}]: ${preview}`,
        {
          messages: request.messages,
          ...debugContext,
        },
      );
    }

    try {
      const raw = await provider.executeChat(request);

      const cost = this.costService.calculateAndAddUsage(
        provider.name,
        request.model,
        config.pricing,
        config.fallbackModel,
        request.costLabel,
        raw.usage,
      );

      const durationSeconds = (Date.now() - startTime) / 1000;
      this.metricsService.recordCompletion(
        provider.name,
        request.model,
        request.costLabel ?? 'unknown',
        durationSeconds,
        raw.usage.promptTokens,
        raw.usage.completionTokens,
        'success',
      );

      // Strip null bytes — Postgres rejects \u0000 in text/jsonb columns
      // and LLMs occasionally produce them in structured output.
      let content = raw.content;
      if (content.includes('\u0000')) {
        content = content.split('\u0000').join('');
      }

      const rawContent = content;

      let parsed: unknown | undefined;
      if (request.schema) {
        const validated = this.validator.validateAndSanitize(
          content,
          request.schema,
          request.strictSchema,
        );
        content = validated.sanitized;
        parsed = validated.parsed;
      }

      if (request.validateResponse) {
        request.validateResponse(parsed);
      }

      if (config.debug) {
        this.logger.debug(
          `AI chat response received [${provider.name}:${request.model}]`,
          {
            response: content,
            messages: request.messages,
            success: true,
            cost,
            usage: raw.usage,
            executionTimeInSec: durationSeconds,
            ...debugContext,
          },
        );
      }

      const response = this.buildResponse({
        chatId,
        provider: provider.name,
        model: request.model,
        content,
        parsed,
        rawUsage: raw.usage,
        cost,
        finishReason: raw.finishReason,
        executionTimeInSec: durationSeconds,
      });

      if (request.traceCollector) {
        try {
          request.traceCollector({
            messages: request.messages as Array<{
              role: string;
              content: string;
            }>,
            rawResponse: rawContent,
            parsedResponse: parsed,
            model: request.model,
            provider: provider.name,
            temperature: request.temperature ?? 1,
            schema: request.schema,
            usage: {
              promptTokens: raw.usage.promptTokens,
              completionTokens: raw.usage.completionTokens,
              totalTokens: raw.usage.totalTokens,
              cachedTokens: raw.usage.cachedTokens,
            },
            cost: cost ?? 0,
            durationMs: durationSeconds * 1000,
            retryCount: request.retryCount ?? 0,
          });
        } catch (traceError) {
          this.logger.warn('Failed to collect trace data', {
            error: traceError,
            ...debugContext,
          });
        }
      }

      return response;
    } catch (error: unknown) {
      this.metricsService.recordCompletion(
        provider.name,
        request.model,
        request.costLabel ?? 'unknown',
        0,
        0,
        0,
        'error',
      );

      this.logger.error(
        'Error creating AI chat completion',
        error,
        debugContext,
      );

      // Rate-limit: don't retry — quota won't recover in milliseconds.
      if (provider.isRateLimitError(error)) {
        throw error;
      }

      const retryCount = request.retryCount ?? 0;
      const maxRetries = request.maxRetries ?? config.maxRetries;
      if (retryCount < maxRetries) {
        this.logger.warn(
          `Retrying AI chat request, attempt ${retryCount + 1}`,
          {
            ...debugContext,
            retryCount: retryCount + 1,
          },
        );
        return this.createChat({
          ...request,
          retryCount: retryCount + 1,
        });
      }

      throw error;
    }
  }

  private buildResponse(params: {
    chatId: string;
    provider: AiProviderName;
    model: string;
    content: string;
    parsed?: unknown;
    rawUsage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedTokens: number;
    };
    cost?: number;
    finishReason?: string;
    executionTimeInSec: number;
  }): AiChatResponse {
    return {
      chatId: params.chatId,
      provider: params.provider,
      model: params.model,
      content: params.content,
      parsed: params.parsed,
      cost: params.cost,
      finishReason: params.finishReason,
      executionTimeInSec: params.executionTimeInSec,
      usage: {
        promptTokens: params.rawUsage.promptTokens,
        completionTokens: params.rawUsage.completionTokens,
        totalTokens: params.rawUsage.totalTokens,
        cachedTokens: params.rawUsage.cachedTokens,
        prompt_tokens: params.rawUsage.promptTokens,
        completion_tokens: params.rawUsage.completionTokens,
        total_tokens: params.rawUsage.totalTokens,
        prompt_tokens_details: { cached_tokens: params.rawUsage.cachedTokens },
      },
      choices: [
        {
          message: { role: 'assistant', content: params.content },
          finish_reason: params.finishReason,
        },
      ],
    };
  }
}
