import { Module } from "@nestjs/common";
import {
  RedditThreadSerializerService,
  RedditTreeService,
  ThreadStatusSearchService,
} from "./services";
import { DatabaseModule } from "@ebike-backend/database";
import { RedditModule } from "@ebike-backend/reddit";
import { RelevanceModule } from "@ebike-backend/relevance";
import { ThreadCreatorService } from "./services/thread-creator.service";
import { ThreadDeletionService } from "./services/thread-deletion.service";
import { CommentReprocessService } from "./services/comment-reprocess.service";
import { ThreadDetailService } from "./services/thread-detail.service";
import { ThreadTreeService } from "./services/thread-tree.service";
import { DebugModule } from "@ebike-backend/debug";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { MetricsModule } from "@ebike-backend/metrics";
import { ProductModule } from "@ebike-backend/product";

@Module({
  imports: [
    DatabaseModule,
    DebugModule,
    DynamicConfigModule,
    RedditModule,
    MetricsModule,
    ProductModule,
    RelevanceModule,
  ],
  controllers: [],
  providers: [
    CommentReprocessService,
    RedditThreadSerializerService,
    RedditTreeService,
    ThreadCreatorService,
    ThreadDeletionService,
    ThreadDetailService,
    ThreadTreeService,
    ThreadStatusSearchService,
  ],
  exports: [
    CommentReprocessService,
    RedditThreadSerializerService,
    ThreadCreatorService,
    ThreadDeletionService,
    ThreadDetailService,
    ThreadTreeService,
    ThreadStatusSearchService,
    RedditTreeService,
  ],
})
export class ThreadModule {}
