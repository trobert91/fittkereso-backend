import { Module } from "@nestjs/common";
import { ThreadProcessingListener } from "./services/thread-processing-listener.service";
import { ProductReviewAnalysisListener } from "./services/product-review-analysis-listener.service";
import { TaskManagerService } from "./services/task-manager.service";
import { AppConfigModule } from "../app-config/app-config.module";
import { ThreadProcessorModule } from "../thread-processor/thread-processor.module";
import { DatabaseModule } from "@ebike-backend/database";
import { TaskModule } from "@ebike-backend/task";
import { ThreadModule } from "@ebike-backend/thread";
import { RedditModule } from "@ebike-backend/reddit";
import { MetricsModule } from "@ebike-backend/metrics";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { ThreadProcessorSharedModule } from "@ebike-backend/thread-processor";
import { ProductModule } from "@ebike-backend/product";

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    TaskModule,
    RedditModule,
    ThreadProcessorModule,
    ThreadModule,
    ThreadProcessorSharedModule,
    MetricsModule,
    DynamicConfigModule,
    ProductModule,
  ],
  providers: [
    ThreadProcessingListener,
    ProductReviewAnalysisListener,
    TaskManagerService,
  ],
})
export class QueueProcessorModule {}
