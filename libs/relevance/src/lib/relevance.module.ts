import { Module } from "@nestjs/common";
import { RelevanceCalculatorService } from "./relevance-calculator.service";
import { ProductModule } from "@ebike-backend/product";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { DatabaseModule } from "@ebike-backend/database";
import { AiModule } from "@ebike-backend/ai";
import { RedditModule } from "@ebike-backend/reddit";
import { DebugModule } from "@ebike-backend/debug";
import { MetricsModule } from "@ebike-backend/metrics";
import { RelevanceTermsService } from "./relevance-terms.service";
import { DeliberationTermsService } from "./deliberation-terms.service";
import {
  CategoryContentRelevanceScorerService,
  CommentRelevanceService,
  ProductMentionRelevanceService,
  ReferenceRelevanceService,
} from "./services";
import { RelevanceConfigService } from "./relevance-config.service";
import { ScoringConfigService } from "./scoring-config.service";
import { ThreadRelevanceEstimationService } from "./thread-relevance-estimation";
import { ThreadSelectionService } from "./thread-selection";

@Module({
  imports: [
    DynamicConfigModule,
    ProductModule,
    DatabaseModule,
    AiModule,
    RedditModule,
    DebugModule,
    MetricsModule,
  ],
  providers: [
    DeliberationTermsService,
    RelevanceCalculatorService,
    RelevanceTermsService,
    CategoryContentRelevanceScorerService,
    ReferenceRelevanceService,
    CommentRelevanceService,
    ProductMentionRelevanceService,
    RelevanceConfigService,
    ScoringConfigService,
    ThreadRelevanceEstimationService,
    ThreadSelectionService,
  ],
  exports: [
    RelevanceCalculatorService,
    CategoryContentRelevanceScorerService,
    ReferenceRelevanceService,
    CommentRelevanceService,
    ProductMentionRelevanceService,
    RelevanceConfigService,
    ScoringConfigService,
    ThreadRelevanceEstimationService,
    ThreadSelectionService,
  ],
})
export class RelevanceModule {}
