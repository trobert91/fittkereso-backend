import { Injectable, OnModuleInit } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import {
  AiChatProvider,
  AiChatRequest,
  AiProviderConfig,
  AiProviderRegistry,
  RawProviderResult,
} from "@ebike-backend/ai-core";
import { ClaudeConfigService as AppClaudeConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import { ClaudeClientService } from "./claude-client.service";
import { ClaudeConfigService } from "./claude-config.service";

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_THINKING_BUDGET = 4096;

function supportsThinking(model: string): boolean {
  return /^claude-(3-7|opus-4|sonnet-4|haiku-4|4)/.test(model);
}

@Injectable()
export class ClaudeChatProvider implements AiChatProvider, OnModuleInit {
  readonly name = "claude" as const;
  private readonly logger = new CustomLogger(ClaudeChatProvider.name);

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly client: ClaudeClientService,
    private readonly claudeConfig: ClaudeConfigService,
    private readonly appClaudeConfig: AppClaudeConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.registerChat(this);
  }

  supports(model: string): boolean {
    return /^claude-/.test(model);
  }

  isRateLimitError(error: unknown): boolean {
    if (!error) return false;
    if (error instanceof Anthropic.RateLimitError) return true;
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
      pricing: this.claudeConfig.pricing,
      fallbackModel: this.claudeConfig.fallbackModel,
      maxRetries: this.claudeConfig.maxRetries,
      debug: this.appClaudeConfig.debug,
    };
  }

  async executeChat(request: AiChatRequest): Promise<RawProviderResult> {
    const { system, messages } = this.toClaudeMessages(request.messages);

    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
      ...(system && { system }),
    };

    if (request.schema) {
      const toolName = request.schemaName ?? request.costLabel ?? "response";
      body.tools = [
        {
          name: toolName,
          description: "Return the response in the required structured format.",
          input_schema: request.schema,
        },
      ];
      body.tool_choice = { type: "tool", name: toolName };
    }

    this.applyReasoning(body, request);

    const response = await this.client.client.messages.create(body);

    const content = this.extractContent(response);
    const usage = response.usage;
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    const cachedTokens = usage?.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0;
    const promptTokens = inputTokens + cachedTokens + cacheCreationTokens;
    const totalTokens = promptTokens + outputTokens;

    return {
      content,
      usage: {
        promptTokens,
        completionTokens: outputTokens,
        totalTokens,
        cachedTokens,
      },
      finishReason: response.stop_reason ?? undefined,
    };
  }

  /**
   * Pull the assistant text out of a Claude response. When tool-use was forced
   * for structured output, serialize the tool input back into a JSON string so
   * the orchestrator's schema validator sees the same shape it gets from the
   * other providers.
   */
  private extractContent(response: Anthropic.Message): string {
    const blocks = response.content ?? [];
    const toolUse = blocks.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (toolUse) {
      return JSON.stringify(toolUse.input ?? {});
    }
    return blocks
      .map((block) => (block.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("");
  }

  /**
   * Translate AiMessage[] into Claude's `system` + `messages` shape. Claude
   * has no `system` role on the messages array — system messages are merged
   * into a single top-level `system` string. Multimodal payloads are reduced
   * to their text parts; image support belongs in a Claude-aware service.
   */
  private toClaudeMessages(messages: AiChatRequest["messages"]): {
    system?: string;
    messages: Anthropic.MessageParam[];
  } {
    const systemParts: string[] = [];
    const claudeMessages: Anthropic.MessageParam[] = [];

    for (const message of messages) {
      const text = this.toText(message.content);
      if (message.role === "system") {
        systemParts.push(text);
      } else {
        claudeMessages.push({
          role: message.role === "assistant" ? "assistant" : "user",
          content: text,
        });
      }
    }

    return {
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      messages: claudeMessages,
    };
  }

  private applyReasoning(
    body: Anthropic.MessageCreateParamsNonStreaming,
    request: AiChatRequest,
  ): void {
    const { thinking, effort, model } = request;
    if (thinking === undefined && effort === undefined) return;

    if (!supportsThinking(model)) {
      if (thinking !== undefined) {
        this.logger.warn("thinking ignored on model without thinking support", {
          provider: this.name,
          model,
          feature: "thinking",
        });
      }
      if (effort !== undefined) {
        this.logger.warn("effort ignored on model without thinking support", {
          provider: this.name,
          model,
          feature: "effort",
        });
      }
      return;
    }

    if (thinking === false) return;

    let budget = DEFAULT_THINKING_BUDGET;
    if (effort !== undefined) {
      const parsed = Number.parseInt(effort, 10);
      if (Number.isNaN(parsed)) {
        this.logger.warn(
          `effort='${effort}' is not an integer budget for claude, defaulting to ${DEFAULT_THINKING_BUDGET}`,
          { provider: this.name, model, feature: "effort" },
        );
      } else {
        budget = parsed;
      }
    }

    body.thinking = { type: "enabled", budget_tokens: budget };
    if (body.max_tokens <= budget) {
      body.max_tokens = budget + DEFAULT_MAX_TOKENS;
    }
  }

  private toText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          const p = part as { text?: string; type?: string };
          return p.text ?? "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }
}
