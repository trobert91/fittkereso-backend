import { Module } from "@nestjs/common";
import { AdminProductController } from "./controllers/admin-product.controller";
import { ProductModule } from "@ebike-backend/product";
import { AdminCategoryController } from "./controllers/admin-category.controller";
import { AuthModule } from "@ebike-backend/auth";
import { AdminThreadController } from "./controllers/admin-thread.controller";
import { SearchModule } from "@ebike-backend/search";
import { ThreadModule } from "@ebike-backend/thread";
import { AdminBrandController } from "./controllers/admin-brand.controller";
import { TaskModule } from "@ebike-backend/task";
import { AdminCommentController } from "./controllers/admin-comment.controller";
import { AdminReviewController } from "./controllers/admin-review.controller";
import { CommentModule } from "@ebike-backend/comment";
import { DatabaseModule } from "@ebike-backend/database";
import { AdminTaskController } from "./controllers/admin-task.controller";
import { AdminTestController } from "./controllers/admin-test.controller";
import { AdminDebugController } from "./controllers/admin-debug.controller";
import { DebugModule } from "@ebike-backend/debug";
import { AdminProductSourceController } from "./controllers/admin-product-source.controller";
import { AdminScrapeTaskController } from "./controllers/admin-scrape-task.controller";
import { AdminThreadSearchTaskController } from "./controllers/admin-thread-search-task.controller";
import { AdminThreadSearchKeywordController } from "./controllers/admin-thread-search-keyword.controller";
import { AdminDuplicateController } from "./controllers/admin-duplicate.controller";
import { AdminThreadRunController } from "./controllers/admin-thread-run.controller";
import { AdminKeywordResearchController } from "./controllers/admin-keyword-research.controller";
import { RelevanceModule } from "@ebike-backend/relevance";
import { ThreadSearchModule } from "@ebike-backend/thread-search";

@Module({
  imports: [
    AuthModule,
    CommentModule,
    DatabaseModule,
    DebugModule,
    ProductModule,
    RelevanceModule,
    SearchModule,
    TaskModule,
    ThreadModule,
    ThreadSearchModule,
  ],
  controllers: [
    AdminBrandController,
    AdminCategoryController,
    AdminDebugController,
    AdminProductController,
    AdminProductSourceController,
    AdminScrapeTaskController,
    AdminThreadSearchTaskController,
    AdminThreadSearchKeywordController,
    AdminReviewController,
    AdminThreadController,
    AdminCommentController,
    AdminTaskController,
    AdminTestController,
    AdminDuplicateController,
    AdminThreadRunController,
    AdminKeywordResearchController,
  ],
})
export class AdminModule {}
