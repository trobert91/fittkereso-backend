import { AiChatRequest } from './ai-chat-request.interface';
import { AiProviderConfig } from './ai-provider-config.interface';
import { AiProviderName } from './ai-provider-name';
import { AiUsage } from './ai-usage.interface';

export interface RawProviderResult {
  content: string;
  usage: AiUsage;
  finishReason?: string;
}

export interface AiChatProvider {
  readonly name: AiProviderName;
  supports(model: string): boolean;
  isRateLimitError(error: unknown): boolean;
  getConfig(): AiProviderConfig;
  executeChat(request: AiChatRequest): Promise<RawProviderResult>;
}
