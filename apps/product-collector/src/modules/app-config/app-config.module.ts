import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './services/app-config.service';
import { AppSettingsConfigService } from './sub-configs/app-settings.config.service';
import {
  PostgresConfigService,
  MongoConfigService,
  OpenAiConfigService,
  GeminiConfigService,
  ClaudeConfigService,
  DeepSeekConfigService,
  DataForSeoConfigService,
  ExaConfigService,
  TaskConfigService,
  LoggerConfigService,
  ZyteConfigService,
  BunnyConfigService,
  CategoryConfigService,
} from '@fittkereso-backend/config';

@Global()
@Module({
  imports: [],
  providers: [
    AppConfigService,
    PostgresConfigService,
    MongoConfigService,
    AppSettingsConfigService,
    OpenAiConfigService,
    GeminiConfigService,
    ClaudeConfigService,
    DeepSeekConfigService,
    DataForSeoConfigService,
    ExaConfigService,
    TaskConfigService,
    LoggerConfigService,
    ZyteConfigService,
    BunnyConfigService,
    CategoryConfigService,
  ],
  exports: [
    AppConfigService,
    PostgresConfigService,
    MongoConfigService,
    AppSettingsConfigService,
    OpenAiConfigService,
    GeminiConfigService,
    ClaudeConfigService,
    DeepSeekConfigService,
    DataForSeoConfigService,
    ExaConfigService,
    TaskConfigService,
    LoggerConfigService,
    ZyteConfigService,
    BunnyConfigService,
    CategoryConfigService,
  ],
})
export class AppConfigModule {}
