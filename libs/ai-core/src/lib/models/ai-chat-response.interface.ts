import { AiProviderName } from './ai-provider-name';
import { AiUsage } from './ai-usage.interface';

/**
 * Provider-agnostic chat response.
 *
 * Exposes both new clean fields (`content`, `parsed`, `usage`) and an
 * OpenAI-compatible shape (`choices`, `usage` with `prompt_tokens` etc.) so
 * existing callers that destructure `response.choices[0].message.content`
 * keep working unchanged.
 */
export interface AiChatResponse {
  chatId: string;
  provider: AiProviderName;
  model: string;

  /** Sanitized response text (null bytes stripped, schema-cleaned if applicable). */
  content: string;
  /** Populated when the request had a schema — already parsed and validated. */
  parsed?: unknown;

  usage: AiUsage & {
    /** Backwards-compat (OpenAI wire shape). */
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: { cached_tokens: number };
  };

  cost?: number;
  finishReason?: string;
  executionTimeInSec: number;

  /** OpenAI-compat shim — `response.choices[0].message.content`. */
  choices: Array<{
    message: { role: 'assistant'; content: string };
    finish_reason?: string;
  }>;
}
