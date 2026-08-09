import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  AiChatProvider,
  AiChatRequest,
  AiProviderConfig,
  AiProviderRegistry,
  RawProviderResult,
} from "@ebike-backend/ai-core";
import { OpenRouterConfigService as AppOpenRouterConfigService } from "@ebike-backend/config";
import {
  OpenRouterApiError,
  OpenRouterChatMessage,
  OpenRouterChatRequestBody,
  OpenRouterClientService,
  OpenRouterReasoningConfig,
} from "./openrouter-client.service";
import { OpenRouterConfigService } from "./openrouter-config.service";

const MODEL_PREFIX = "openrouter:";

@Injectable()
export class OpenRouterChatProvider implements AiChatProvider, OnModuleInit {
  readonly name = "openrouter" as const;

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly client: OpenRouterClientService,
    private readonly openRouterConfig: OpenRouterConfigService,
    private readonly appOpenRouterConfig: AppOpenRouterConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.registerChat(this);
  }

  supports(model: string): boolean {
    return model.startsWith(MODEL_PREFIX);
  }

  isRateLimitError(error: unknown): boolean {
    if (!error) return false;
    if (error instanceof OpenRouterApiError && error.status === 429)
      return true;
    const anyError = error as {
      status?: number;
      code?: number | string;
      message?: string;
    };
    if (
      anyError.status === 429 ||
      anyError.code === 429 ||
      anyError.code === "rate_limit_error"
    ) {
      return true;
    }
    return /rate.?limit|quota/i.test(anyError.message ?? "");
  }

  getConfig(): AiProviderConfig {
    return {
      pricing: this.openRouterConfig.pricing,
      fallbackModel: this.openRouterConfig.fallbackModel,
      maxRetries: this.openRouterConfig.maxRetries,
      debug: this.appOpenRouterConfig.debug,
    };
  }

  async executeChat(request: AiChatRequest): Promise<RawProviderResult> {
    const openRouterModel = request.model.slice(MODEL_PREFIX.length);

    const body: OpenRouterChatRequestBody = {
      model: openRouterModel,
      messages: request.messages as OpenRouterChatMessage[],
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
      ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
    };

    if (request.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: request.schemaName ?? request.costLabel ?? "response",
          schema: request.schema,
        },
      };
    }

    const reasoning = this.buildReasoning(request.thinking, request.effort);
    if (reasoning) body.reasoning = reasoning;

    const response = await this.client.createChatCompletion(body);

    const content = response.choices[0]?.message?.content ?? "";
    const usage = response.usage;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;

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

  private buildReasoning(
    thinking: boolean | undefined,
    effort: string | undefined,
  ): OpenRouterReasoningConfig | undefined {
    const reasoning: OpenRouterReasoningConfig = {};
    if (effort !== undefined) reasoning.effort = effort;
    if (thinking === false) reasoning.exclude = true;
    return reasoning.effort === undefined && reasoning.exclude === undefined
      ? undefined
      : reasoning;
  }
}
