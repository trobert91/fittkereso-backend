import { Module } from "@nestjs/common";
import { AiModule } from "@ebike-backend/ai";
import { DatabaseModule } from "@ebike-backend/database";
import { RedditModule } from "@ebike-backend/reddit";
import { MetricsModule } from "@ebike-backend/metrics";
import { ThreadModule } from "@ebike-backend/thread";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { DebugModule } from "@ebike-backend/debug";
import { TaskModule } from "@ebike-backend/task";
import { RelevanceModule } from "@ebike-backend/relevance";
import { KeywordBudgetAllocator } from "./services/keyword-budget-allocator.service";
import { KeywordStatsService } from "./services/keyword-stats.service";
import { KeywordCooldownService } from "./services/keyword-cooldown.service";
import { TopProductSamplerService } from "./services/top-product-sampler.service";
import { KeywordPlannerService } from "./services/keyword-planner.service";
import { KeywordCategoryPlannerService } from "./services/keyword-category-planner.service";
import { KeywordResearchOrchestrator } from "./services/keyword-research-orchestrator.service";
import { ThreadSearchExecutor } from "./services/thread-search-executor.service";
import { RedditSearchHandler } from "./handlers/reddit-search.handler";

@Module({
  imports: [
    AiModule,
    DatabaseModule,
    DebugModule,
    DynamicConfigModule,
    MetricsModule,
    RedditModule,
    RelevanceModule,
    TaskModule,
    ThreadModule,
  ],
  providers: [
    KeywordBudgetAllocator,
    KeywordStatsService,
    KeywordCooldownService,
    TopProductSamplerService,
    KeywordPlannerService,
    KeywordCategoryPlannerService,
    KeywordResearchOrchestrator,
    ThreadSearchExecutor,
    RedditSearchHandler,
  ],
  exports: [
    KeywordBudgetAllocator,
    KeywordCategoryPlannerService,
    KeywordResearchOrchestrator,
    KeywordStatsService,
    ThreadSearchExecutor,
    RedditSearchHandler,
  ],
})
export class ThreadSearchModule {}
