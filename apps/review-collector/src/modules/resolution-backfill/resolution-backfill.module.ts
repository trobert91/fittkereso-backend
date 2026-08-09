import { Module } from "@nestjs/common";
import { DatabaseModule } from "@ebike-backend/database";
import { DebugModule } from "@ebike-backend/debug";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { MetricsModule } from "@ebike-backend/metrics";
import { TaskModule } from "@ebike-backend/task";
import { ResolutionModule } from "@ebike-backend/resolution";
import { ProductModule } from "@ebike-backend/product";
// Provides CommentModerationDecisionService (re-moderation rule) + ProcessorConfigService.
import { ThreadProcessorSharedModule } from "@ebike-backend/thread-processor";
import { ResolutionBackfillService } from "./services/resolution-backfill.service";
import { ResolutionBackfillScheduler } from "./services/resolution-backfill.scheduler";

@Module({
  imports: [
    DatabaseModule,
    DebugModule,
    DynamicConfigModule,
    MetricsModule,
    ProductModule,
    ResolutionModule,
    ThreadProcessorSharedModule,
    TaskModule,
  ],
  providers: [ResolutionBackfillService, ResolutionBackfillScheduler],
})
export class ResolutionBackfillModule {}
