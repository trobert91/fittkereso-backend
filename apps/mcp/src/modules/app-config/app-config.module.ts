import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './services/app-config.service';
import {
  PostgresConfigService,
  LoggerConfigService,
  CategoryConfigService,
  OpenAiConfigService,
  GeminiConfigService,
  ClaudeConfigService,
  DeepSeekConfigService,
} from '@fittkereso-backend/config';

@Global()
@Module({
  imports: [],
  providers: [
    AppConfigService,
    PostgresConfigService,
    LoggerConfigService,
    CategoryConfigService,
    OpenAiConfigService,
    GeminiConfigService,
    ClaudeConfigService,
    DeepSeekConfigService,
  ],
  exports: [
    AppConfigService,
    PostgresConfigService,
    LoggerConfigService,
    CategoryConfigService,
    OpenAiConfigService,
    GeminiConfigService,
    ClaudeConfigService,
    DeepSeekConfigService,
  ],
})
export class AppConfigModule {}
