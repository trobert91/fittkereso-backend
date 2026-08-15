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
  ZyteConfigService,
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
    ZyteConfigService,
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
    ZyteConfigService,
  ],
})
export class AppConfigModule {}
