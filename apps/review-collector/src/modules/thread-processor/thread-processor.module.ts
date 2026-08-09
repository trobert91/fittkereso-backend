import { Module } from "@nestjs/common";
import { ThreadProcessorService } from "./services/thread-processor.service";
import { ThreadContextService } from "./services/thread-context.service";
import { CommentModule } from "@ebike-backend/comment";
import { DatabaseModule } from "@ebike-backend/database";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { MetricsModule } from "@ebike-backend/metrics";
import { DebugModule } from "@ebike-backend/debug";
import { ThreadProcessorModule as ThreadProcessorLibModule } from "@ebike-backend/thread-processor";

@Module({
  imports: [
    CommentModule,
    DatabaseModule,
    DebugModule,
    DynamicConfigModule,
    MetricsModule,
    ThreadProcessorLibModule,
  ],
  providers: [ThreadProcessorService, ThreadContextService],
  exports: [
    ThreadProcessorService,
    ThreadContextService,
    ThreadProcessorLibModule,
  ],
})
export class ThreadProcessorModule {}
