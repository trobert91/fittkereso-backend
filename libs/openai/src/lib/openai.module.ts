import { Module } from '@nestjs/common';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { AiProviderRegistryModule } from '@fittkereso-backend/ai-core';
import { OpenAiClientService } from './services/open-ai-client.service';
import { OpenAiEmbeddingService } from './services/open-ai-embedding.service';
import { OpenAiChatProvider } from './services/open-ai-chat.provider';
import { OpenAiEmbeddingProvider } from './services/open-ai-embedding.provider';
import { OpenAiConfigService } from './services/openai-config.service';

@Module({
  imports: [DynamicConfigModule, AiProviderRegistryModule],
  providers: [
    OpenAiClientService,
    OpenAiEmbeddingService,
    OpenAiConfigService,
    OpenAiChatProvider,
    OpenAiEmbeddingProvider,
  ],
  exports: [
    OpenAiClientService,
    OpenAiEmbeddingService,
    OpenAiConfigService,
    OpenAiChatProvider,
    OpenAiEmbeddingProvider,
  ],
})
export class OpenAiModule {}
