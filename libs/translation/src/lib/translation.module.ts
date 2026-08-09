import { Module } from "@nestjs/common";
import { DatabaseModule } from "@ebike-backend/database";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { MetricsModule } from "@ebike-backend/metrics";
import { AiModule } from "@ebike-backend/ai";
import { TranslationService } from "./services/translation.service";

@Module({
  imports: [DatabaseModule, DynamicConfigModule, MetricsModule, AiModule],
  providers: [TranslationService],
  exports: [TranslationService],
})
export class TranslationModule {}
