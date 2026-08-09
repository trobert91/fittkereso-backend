import { Module } from "@nestjs/common";
import { CommentReviewSchedulerService } from "./schedulers/comment-review-scheduler.service";
import { DatabaseModule } from "@ebike-backend/database";
import { TaskModule } from "@ebike-backend/task";
import { ProcessThreadScheduler } from "./schedulers/process-thread-scheduler";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { ThreadModule } from "@ebike-backend/thread";
import { MetricsModule } from "@ebike-backend/metrics";
import { ReviewCreatorModule } from "../review-creator/review-creator.module";
import { ProductRatingScheduler } from "./schedulers/product-rating-scheduler";
import { ProductReviewAnalysisScheduler } from "./schedulers/product-review-analysis-scheduler";
import { ProductModule } from "@ebike-backend/product";
import { ResolutionBackfillModule } from "../resolution-backfill/resolution-backfill.module";
import { ProcessorConfigService } from "@ebike-backend/config";
import { KeywordResearchScheduler } from "./schedulers/keyword-research-scheduler.service";
import { ThreadSearchTaskScheduler } from "./schedulers/thread-search-task-scheduler.service";
import { ThreadSearchModule } from "@ebike-backend/thread-search";
import { DebugModule } from "@ebike-backend/debug";
import { RelevanceModule } from "@ebike-backend/relevance";

@Module({
  imports: [
    DatabaseModule,
    DebugModule,
    ResolutionBackfillModule,
    DynamicConfigModule,
    ProductModule,
    RelevanceModule,
    TaskModule,
    ThreadModule,
    ThreadSearchModule,
    MetricsModule,
    ReviewCreatorModule,
  ],
  providers: [
    ProcessorConfigService,
    ProcessThreadScheduler,
    KeywordResearchScheduler,
    ThreadSearchTaskScheduler,
    CommentReviewSchedulerService,
    ProductRatingScheduler,
    ProductReviewAnalysisScheduler,
  ],
  exports: [ProcessThreadScheduler],
})
export class SchedulingModule {}
