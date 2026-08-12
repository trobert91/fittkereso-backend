import { Injectable } from '@nestjs/common';
import { DeepSeekConfigService as AppDeepSeekConfigService } from '@fittkereso-backend/config';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export interface DeepSeekChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | unknown[];
}

export interface DeepSeekResponseFormat {
  type: 'json_object';
}

export interface DeepSeekThinkingConfig {
  type: 'enabled' | 'disabled';
  reasoning_effort?: string;
}

export interface DeepSeekChatRequestBody {
  model: string;
  messages: DeepSeekChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: DeepSeekResponseFormat;
  thinking?: DeepSeekThinkingConfig;
}

export interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface DeepSeekChatResponse {
  choices: Array<{
    message: { role: 'assistant'; content: string | null };
    finish_reason?: string;
  }>;
  usage?: DeepSeekUsage;
}

export class DeepSeekApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'DeepSeekApiError';
  }
}

/**
 * Direct HTTP wrapper for DeepSeek's OpenAI-compatible chat completions API.
 *
 * DeepSeek does not ship a server-side SDK; their docs recommend pointing the
 * OpenAI SDK at their base URL. We use plain `fetch` here so the DeepSeek
 * integration stays cleanly separated from the OpenAI provider's client and
 * mirrors the OpenRouter library's pattern.
 */
@Injectable()
export class DeepSeekClientService {
  constructor(private readonly deepSeekConfig: AppDeepSeekConfigService) {}

  async createChatCompletion(
    body: DeepSeekChatRequestBody,
  ): Promise<DeepSeekChatResponse> {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.deepSeekConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new DeepSeekApiError(
        `DeepSeek chat completion failed (${response.status}): ${errorBody}`,
        response.status,
        errorBody,
      );
    }

    return (await response.json()) as DeepSeekChatResponse;
  }
}
