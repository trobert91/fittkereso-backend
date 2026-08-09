import { Module } from "@nestjs/common";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { AiProviderRegistryModule } from "@ebike-backend/ai-core";
import { GeminiClientService } from "./services/gemini-client.service";
import { GeminiConfigService } from "./services/gemini-config.service";
import { GeminiChatProvider } from "./services/gemini-chat.provider";

@Module({
  imports: [DynamicConfigModule, AiProviderRegistryModule],
  providers: [GeminiClientService, GeminiConfigService, GeminiChatProvider],
  exports: [GeminiClientService, GeminiConfigService, GeminiChatProvider],
})
export class GeminiModule {}
