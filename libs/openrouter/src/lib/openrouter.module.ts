import { Module } from "@nestjs/common";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { AiProviderRegistryModule } from "@ebike-backend/ai-core";
import { OpenRouterClientService } from "./services/openrouter-client.service";
import { OpenRouterConfigService } from "./services/openrouter-config.service";
import { OpenRouterChatProvider } from "./services/openrouter-chat.provider";

@Module({
  imports: [DynamicConfigModule, AiProviderRegistryModule],
  providers: [
    OpenRouterClientService,
    OpenRouterConfigService,
    OpenRouterChatProvider,
  ],
  exports: [
    OpenRouterClientService,
    OpenRouterConfigService,
    OpenRouterChatProvider,
  ],
})
export class OpenRouterModule {}
