import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  AiChatProvider,
  AiChatRequest,
  AiProviderConfig,
  AiProviderRegistry,
  RawProviderResult,
} from "@ebike-backend/ai-core";
import { DeepSeekConfigService as AppDeepSeekConfigService } from "@ebike-backend/config";
import {
  DeepSeekApiError,
  DeepSeekChatMessage,
  DeepSeekChatRequestBody,
  DeepSeekClientService,
  DeepSeekThinkingConfig,
} from "./deepseek-client.service";
import { DeepSeekConfigService } from "./deepseek-config.service";

function messagesMentionJson(messages: DeepSeekChatMessage[]): boolean {
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      if (/json/i.test(content)) return true;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "string" && /json/i.test(part)) return true;
      const text = (part as { text?: string }).text;
      if (typeof text === "string" && /json/i.test(text)) return true;
    }
  }
  return false;
}

@Injectable()
export class DeepSeekChatProvider implements AiChatProvider, OnModuleInit {
  readonly name = "deepseek" as const;

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly client: DeepSeekClientService,
    private readonly deepSeekConfig: DeepSeekConfigService,
    private readonly appDeepSeekConfig: AppDeepSeekConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.registerChat(this);
  }

  supports(model: string): boolean {
    return /^deepseek-/.test(model);
  }

  isRateLimitError(error: unknown): boolean {
    if (!error) return false;
    if (error instanceof DeepSeekApiError && error.status === 429) return true;
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
      pricing: this.deepSeekConfig.pricing,
      fallbackModel: this.deepSeekConfig.fallbackModel,
      maxRetries: this.deepSeekConfig.maxRetries,
      debug: this.appDeepSeekConfig.debug,
    };
  }

  async executeChat(request: AiChatRequest): Promise<RawProviderResult> {
    let messages = request.messages as DeepSeekChatMessage[];

    // DeepSeek's JSON Mode only supports `{ type: 'json_object' }` — it does
    // not understand OpenAI's strict `json_schema` shape. The actual schema is
    // enforced downstream by AiSchemaValidatorService.
    //
    // DeepSeek's JSON mode also requires the prompt to (a) contain the word
    // "json" and (b) include an example of the desired structure
    // (api-docs.deepseek.com/guides/json_mode). Without those, the API returns
    // HTTP 400 with code: invalid_request_error. When the caller's prompt
    // already mentions JSON we trust they've handled both — otherwise we
    // prepend a system message containing the word + the JSON schema serving
    // as the structural example.
    let responseFormat: DeepSeekChatRequestBody["response_format"] | undefined;
    if (request.schema) {
      responseFormat = { type: "json_object" };
      if (!messagesMentionJson(messages)) {
        const schemaJson = JSON.stringify(request.schema);
        messages = [
          {
            role: "system",
            content: `Respond with valid JSON matching this JSON schema:\n${schemaJson}`,
          },
          ...messages,
        ];
      }
    }

    const thinking = this.buildThinking(request.thinking, request.effort);

    const body: DeepSeekChatRequestBody = {
      model: request.model,
      messages,
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
      ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
      ...(responseFormat && { response_format: responseFormat }),
      ...(thinking && { thinking }),
    };

    const response = await this.client.createChatCompletion(body);

    const content = response.choices[0]?.message?.content ?? "";
    const usage = response.usage;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
    const cachedTokens =
      usage?.prompt_cache_hit_tokens ??
      usage?.prompt_tokens_details?.cached_tokens ??
      0;

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

  private buildThinking(
    thinking: boolean | undefined,
    effort: string | undefined,
  ): DeepSeekThinkingConfig | undefined {
    if (thinking === undefined && effort === undefined) return undefined;
    if (thinking === false) return { type: "disabled" };
    return {
      type: "enabled",
      ...(effort !== undefined && { reasoning_effort: effort }),
    };
  }
}
