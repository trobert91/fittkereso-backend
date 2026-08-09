import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  AiChatProvider,
  AiChatRequest,
  AiProviderConfig,
  AiProviderRegistry,
  RawProviderResult,
} from "@ebike-backend/ai-core";
import { GeminiConfigService as AppGeminiConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import { GeminiConfigService } from "./gemini-config.service";
import { GeminiClientService } from "./gemini-client.service";

function supportsThinking(model: string): boolean {
  return /^gemini-2\.5/.test(model) || /^gemini-3/.test(model);
}

@Injectable()
export class GeminiChatProvider implements AiChatProvider, OnModuleInit {
  readonly name = "gemini" as const;
  private readonly logger = new CustomLogger(GeminiChatProvider.name);

  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly client: GeminiClientService,
    private readonly geminiConfig: GeminiConfigService,
    private readonly appGeminiConfig: AppGeminiConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.registerChat(this);
  }

  supports(model: string): boolean {
    return /^gemini-/.test(model);
  }

  isRateLimitError(error: unknown): boolean {
    if (!error) return false;
    const anyError = error as {
      status?: number;
      code?: number | string;
      message?: string;
    };
    if (
      anyError.status === 429 ||
      anyError.code === 429 ||
      anyError.code === "RESOURCE_EXHAUSTED"
    ) {
      return true;
    }
    return /rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(anyError.message ?? "");
  }

  getConfig(): AiProviderConfig {
    return {
      pricing: this.geminiConfig.pricing,
      fallbackModel: this.geminiConfig.fallbackModel,
      maxRetries: this.geminiConfig.maxRetries,
      debug: this.appGeminiConfig.debug,
    };
  }

  async executeChat(request: AiChatRequest): Promise<RawProviderResult> {
    const { systemInstruction, contents } = this.toGeminiMessages(
      request.messages,
    );

    const config: Record<string, unknown> = {};
    if (request.temperature !== undefined) {
      config["temperature"] = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      config["maxOutputTokens"] = request.maxTokens;
    }
    if (request.schema) {
      config["responseMimeType"] = "application/json";
      config["responseJsonSchema"] = request.schema;
    }
    if (systemInstruction) {
      config["systemInstruction"] = systemInstruction;
    }

    this.applyReasoning(config, request);

    const result = await this.client.client.models.generateContent({
      model: request.model,
      contents,
      config,
    } as any);

    const content = this.extractText(result);
    const usageMetadata =
      (result as { usageMetadata?: any }).usageMetadata ?? {};
    const promptTokens = usageMetadata.promptTokenCount ?? 0;
    const completionTokens = usageMetadata.candidatesTokenCount ?? 0;
    const totalTokens =
      usageMetadata.totalTokenCount ?? promptTokens + completionTokens;
    const cachedTokens = usageMetadata.cachedContentTokenCount ?? 0;

    const finishReason = (
      result as { candidates?: Array<{ finishReason?: string }> }
    ).candidates?.[0]?.finishReason;

    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
      },
      finishReason,
    };
  }

  /**
   * Extract the assistant text from a Gemini response. The SDK exposes
   * a `.text` accessor on the response and on candidates; fall back to
   * walking parts when that is not present.
   */
  private extractText(result: unknown): string {
    const r = result as {
      text?: string | (() => string);
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    if (typeof r.text === "function") {
      return r.text() ?? "";
    }
    if (typeof r.text === "string") {
      return r.text;
    }

    const parts = r.candidates?.[0]?.content?.parts ?? [];
    return parts
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("");
  }

  /**
   * Translate AiMessage[] into Gemini's `systemInstruction` + `contents`
   * shape. Gemini has no `system` role — system messages are merged into
   * a single `systemInstruction` string. Multimodal content is passed
   * through as-is via `parts`.
   */
  private toGeminiMessages(messages: AiChatRequest["messages"]): {
    systemInstruction?: string;
    contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  } {
    const systemParts: string[] = [];
    const contents: Array<{
      role: "user" | "model";
      parts: Array<{ text: string }>;
    }> = [];

    for (const message of messages) {
      const text = this.toText(message.content);
      if (message.role === "system") {
        systemParts.push(text);
      } else {
        contents.push({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text }],
        });
      }
    }

    return {
      ...(systemParts.length > 0
        ? { systemInstruction: systemParts.join("\n\n") }
        : {}),
      contents,
    };
  }

  private applyReasoning(
    config: Record<string, unknown>,
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

    if (thinking === false) {
      config["thinkingConfig"] = { thinkingBudget: 0 };
      return;
    }

    if (effort !== undefined) {
      const budget = Number.parseInt(effort, 10);
      if (Number.isNaN(budget)) {
        this.logger.warn(
          `effort='${effort}' is not an integer budget for gemini, ignoring`,
          { provider: this.name, model, feature: "effort" },
        );
        return;
      }
      config["thinkingConfig"] = { thinkingBudget: budget };
    }
  }

  private toText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      // Multimodal payloads (e.g. image_url): collect text parts; ignore
      // non-text blocks. Gemini supports images through a different code
      // path — image callers should switch to a Gemini-aware service.
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
