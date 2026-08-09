import { Module } from "@nestjs/common";
import {
  BrandSearchService,
  ProductDuplicationSearchService,
  ProductDuplicateSearchService,
  ProductSourceSearchService,
  ProductCategorySearchService,
  ProductSearchService,
  ReviewSearchService,
  ScrapeTaskSearchService,
  TaskSearchService,
  ThreadSearchService,
  ThreadSearchTaskSearchService,
  ThreadSearchKeywordSearchService,
  ThreadRunSearchService,
} from "./services";
import { DatabaseModule } from "@ebike-backend/database";
import { UserCommentSearchService } from "./services/user-comment-search.service";

@Module({
  imports: [DatabaseModule],
  controllers: [],
  providers: [
    BrandSearchService,
    ProductDuplicationSearchService,
    ProductDuplicateSearchService,
    ProductSourceSearchService,
    ProductCategorySearchService,
    ProductSearchService,
    ReviewSearchService,
    ScrapeTaskSearchService,
    TaskSearchService,
    ThreadSearchService,
    ThreadSearchTaskSearchService,
    ThreadSearchKeywordSearchService,
    ThreadRunSearchService,
    UserCommentSearchService,
  ],
  exports: [
    BrandSearchService,
    ProductDuplicationSearchService,
    ProductDuplicateSearchService,
    ProductSourceSearchService,
    ProductCategorySearchService,
    ProductSearchService,
    ReviewSearchService,
    ScrapeTaskSearchService,
    TaskSearchService,
    ThreadSearchService,
    ThreadSearchTaskSearchService,
    ThreadSearchKeywordSearchService,
    ThreadRunSearchService,
    UserCommentSearchService,
  ],
})
export class SearchModule {}
