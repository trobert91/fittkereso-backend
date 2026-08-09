import { Global, Module } from "@nestjs/common";
import { AppConfigService } from "./services/app-config.service";
import {
  PostgresConfigService,
  LoggerConfigService,
  CategoryConfigService,
  SourceConfigService,
  OpenAiConfigService,
  GeminiConfigService,
  ClaudeConfigService,
  OpenRouterConfigService,
  DeepSeekConfigService,
} from "@ebike-backend/config";

@Global()
@Module({
  imports: [],
  providers: [
    AppConfigService,
    PostgresConfigService,
    LoggerConfigService,
    CategoryConfigService,
    SourceConfigService,
    OpenAiConfigService,
    GeminiConfigService,
    ClaudeConfigService,
    OpenRouterConfigService,
    DeepSeekConfigService,
  ],
  exports: [
    AppConfigService,
    PostgresConfigService,
    LoggerConfigService,
    CategoryConfigService,
    SourceConfigService,
    OpenAiConfigService,
    GeminiConfigService,
    ClaudeConfigService,
    OpenRouterConfigService,
    DeepSeekConfigService,
  ],
})
export class AppConfigModule {}
