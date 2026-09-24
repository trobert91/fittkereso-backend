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
  DataForSeoConfigService,
  BunnyConfigService,
  TaskConfigService,
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
    DataForSeoConfigService,
    BunnyConfigService,
    TaskConfigService,
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
    DataForSeoConfigService,
    BunnyConfigService,
    TaskConfigService,
  ],
})
export class AppConfigModule {}
