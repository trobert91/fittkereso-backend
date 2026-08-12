import { Injectable, OnModuleInit } from '@nestjs/common';
import { RateLimitError } from 'openai';
import {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources';
import {
  AiChatProvider,
  AiChatRequest,
  AiProviderConfig,
  AiProviderRegistry,
  RawProviderResult,
} from '@fittkereso-backend/ai-core';
import { OpenAiConfigService as AppOpenAiConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { OpenAiClientService } from './open-ai-client.service';
import { OpenAiConfigService } from './openai-config.service';

// Widen the SDK's strict enum so the caller can supply any effort string the
// API accepts (matches the design: effort is provider/model-specific and
// forwarded as-is). The narrow SDK enum lags real-world supported values.
type OpenAiChatBody = Omit<
  ChatCompletionCreateParamsNonStreaming,
  'reasoning_effort'
> & {
  reasoning_effort?: string;
};

function isReasoningModel(model: string): boolean {
  return /^o[1-9]/.test(model) || /^gpt-5/.test(model);
}

@Injectable()
export class OpenAiChatProvider implements AiChatProvider, OnModuleInit {
  readonly name = 'openai' as const;
  private readonly logger = new CustomLogger(OpenAiChatProvider.name);

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly client: OpenAiClientService,
    private readonly openAiConfig: OpenAiConfigService,
    private readonly appOpenAiConfig: AppOpenAiConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.registerChat(this);
  }

  supports(model: string): boolean {
    return /^(gpt-|o1-|o3-)/.test(model);
  }

  isRateLimitError(error: unknown): boolean {
    return error instanceof RateLimitError;
  }

  getConfig(): AiProviderConfig {
    return {
      pricing: this.openAiConfig.pricing,
      fallbackModel: 'deepseek-v4-flash',
      maxRetries: this.openAiConfig.maxRetries,
      debug: this.appOpenAiConfig.debug,
    };
  }

  async executeChat(request: AiChatRequest): Promise<RawProviderResult> {
    const body: OpenAiChatBody = {
      model: request.model,
      messages: request.messages as ChatCompletionMessageParam[],
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
      ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
    };

    if (request.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName ?? request.costLabel ?? 'response',
          schema: request.schema,
        },
      };
    }

    this.applyReasoning(body, request);

    const response = await this.client.openAi.chat.completions.create(
      body as ChatCompletionCreateParamsNonStreaming,
    );

    const content = response.choices[0]?.message?.content ?? '';
    const usage = response.usage;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
    const cachedTokens =
      (
        usage as
          | { prompt_tokens_details?: { cached_tokens?: number } }
          | undefined
      )?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
      },
      finishReason: response.choices[0]?.finish_reason,
    };
  }

  private applyReasoning(body: OpenAiChatBody, request: AiChatRequest): void {
    const { thinking, effort, model } = request;
    if (thinking === undefined && effort === undefined) return;

    const reasoning = isReasoningModel(model);
    if (!reasoning) {
      if (thinking !== undefined) {
        this.logger.warn('thinking ignored on non-reasoning model', {
          provider: this.name,
          model,
          feature: 'thinking',
        });
      }
      if (effort !== undefined) {
        this.logger.warn('effort ignored on non-reasoning model', {
          provider: this.name,
          model,
          feature: 'effort',
        });
      }
      return;
    }

    if (thinking === false) {
      this.logger.warn('thinking=false ignored on reasoning model', {
        provider: this.name,
        model,
        feature: 'thinking',
      });
    }
    if (effort !== undefined) {
      body.reasoning_effort = effort;
    }
  }
}
