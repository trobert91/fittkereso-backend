import { Injectable } from "@nestjs/common";
import { OpenRouterConfigService as AppOpenRouterConfigService } from "@ebike-backend/config";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterChatMessage {
  role: "system" | "user" | "assistant";
  content: string | unknown[];
}

export interface OpenRouterResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    schema: unknown;
  };
}

export interface OpenRouterReasoningConfig {
  effort?: string;
  exclude?: boolean;
}

export interface OpenRouterChatRequestBody {
  model: string;
  messages: OpenRouterChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: OpenRouterResponseFormat;
  reasoning?: OpenRouterReasoningConfig;
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface OpenRouterChatResponse {
  choices: Array<{
    message: { role: "assistant"; content: string | null };
    finish_reason?: string;
  }>;
  usage?: OpenRouterUsage;
}

export class OpenRouterApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "OpenRouterApiError";
  }
}

/**
 * Direct HTTP wrapper for OpenRouter's OpenAI-compatible chat completions API.
 *
 * OpenRouter does not ship an official server-side SDK on npm — their docs
 * recommend pointing the OpenAI SDK at their base URL. We use plain `fetch`
 * here to keep the OpenRouter integration cleanly separated from the OpenAI
 * provider's client and to avoid a stale third-party dependency.
 */
@Injectable()
export class OpenRouterClientService {
  constructor(private readonly openRouterConfig: AppOpenRouterConfigService) {}

  async createChatCompletion(
    body: OpenRouterChatRequestBody,
  ): Promise<OpenRouterChatResponse> {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.openRouterConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new OpenRouterApiError(
        `OpenRouter chat completion failed (${response.status}): ${errorBody}`,
        response.status,
        errorBody,
      );
    }

    return (await response.json()) as OpenRouterChatResponse;
  }
}
