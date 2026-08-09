import { Injectable } from '@nestjs/common';
import { AiChatProvider } from '../models/ai-chat-provider.interface';
import { AiEmbeddingProvider } from '../models/ai-embedding-provider.interface';

@Injectable()
export class AiProviderRegistry {
  private readonly chatProviders: AiChatProvider[] = [];
  private readonly embeddingProviders: AiEmbeddingProvider[] = [];

  registerChat(provider: AiChatProvider): void {
    if (!this.chatProviders.includes(provider)) {
      this.chatProviders.push(provider);
    }
  }

  registerEmbedding(provider: AiEmbeddingProvider): void {
    if (!this.embeddingProviders.includes(provider)) {
      this.embeddingProviders.push(provider);
    }
  }

  resolveChat(model: string): AiChatProvider {
    const provider = this.chatProviders.find((p) => p.supports(model));
    if (!provider) {
      const supported = this.chatProviders.map((p) => p.name).join(', ');
      throw new Error(
        `No AI chat provider supports model "${model}". Registered providers: [${supported}]. ` +
          `Supported model prefixes: gpt-/o1-/o3- → openai, gemini- → gemini, claude- → claude, deepseek- → deepseek, openrouter: → openrouter.`,
      );
    }
    return provider;
  }

  resolveEmbedding(model: string): AiEmbeddingProvider {
    const provider = this.embeddingProviders.find((p) => p.supports(model));
    if (!provider) {
      const supported = this.embeddingProviders.map((p) => p.name).join(', ');
      throw new Error(
        `No AI embedding provider supports model "${model}". Registered providers: [${supported}].`,
      );
    }
    return provider;
  }
}
