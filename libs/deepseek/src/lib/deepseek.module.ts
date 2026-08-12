import { Module } from '@nestjs/common';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { AiProviderRegistryModule } from '@fittkereso-backend/ai-core';
import { DeepSeekClientService } from './services/deepseek-client.service';
import { DeepSeekConfigService } from './services/deepseek-config.service';
import { DeepSeekChatProvider } from './services/deepseek-chat.provider';

@Module({
  imports: [DynamicConfigModule, AiProviderRegistryModule],
  providers: [
    DeepSeekClientService,
    DeepSeekConfigService,
    DeepSeekChatProvider,
  ],
  exports: [DeepSeekClientService, DeepSeekConfigService, DeepSeekChatProvider],
})
export class DeepSeekModule {}
