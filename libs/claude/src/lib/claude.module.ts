import { Module } from "@nestjs/common";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { AiProviderRegistryModule } from "@ebike-backend/ai-core";
import { ClaudeClientService } from "./services/claude-client.service";
import { ClaudeConfigService } from "./services/claude-config.service";
import { ClaudeChatProvider } from "./services/claude-chat.provider";

@Module({
  imports: [DynamicConfigModule, AiProviderRegistryModule],
  providers: [ClaudeClientService, ClaudeConfigService, ClaudeChatProvider],
  exports: [ClaudeClientService, ClaudeConfigService, ClaudeChatProvider],
})
export class ClaudeModule {}
