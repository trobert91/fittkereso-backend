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
  TaskConfigService,
  LoggerConfigService,
  ZyteConfigService,
  SupabaseConfigService,
  BunnyConfigService,
  CategoryConfigService,
} from '@fittkereso-backend/config';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';

@Global()
@Module({
  imports: [DynamicConfigModule],
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
    TaskConfigService,
    LoggerConfigService,
    ZyteConfigService,
    SupabaseConfigService,
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
    TaskConfigService,
    LoggerConfigService,
    ZyteConfigService,
    SupabaseConfigService,
    BunnyConfigService,
    CategoryConfigService,
  ],
})
export class AppConfigModule {}
