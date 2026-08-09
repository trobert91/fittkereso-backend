import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductModel } from './postgres/models/product-model.entity';
import { ProductCategory } from './postgres/models/product-category.entity';
import { Thread } from './postgres/models/thread.entity';
import { ThreadRun } from './postgres/models/thread-run.entity';
import { ThreadRunRepository } from './postgres/repositories/thread-run-repository';
import { Review } from './postgres/models/review.entity';
import { ReviewFeedback } from './postgres/models/review-feedback.entity';
import { ReviewLabel } from './postgres/models/review-label.entity';
import { ReviewLabelRepository } from './postgres/repositories/review-label-repository';
import { ThreadRepository } from './postgres/repositories/thread-repository';
import { ProductAlias } from './postgres/models/product-alias.entity';
import { ProductCategoryRepository } from './postgres/repositories/product-category-repository';
import { ProductModelRepository } from './postgres/repositories/product-model-repository';
import { ProductModelSource } from './postgres/models/product-model-source.entity';
import { ProductModelSourceRepository } from './postgres/repositories/product-model-source-repository';
import { ProductAliasRepository } from './postgres/repositories/product-alias-repository';
import { ProductReference } from './postgres/models/product-reference.entity';
import { ProductReferenceRepository } from './postgres/repositories/product-reference-repository';
import { ProductReferenceCandidate } from './postgres/models/product-reference-candidate.entity';
import { ProductReferenceCandidateRepository } from './postgres/repositories/product-reference-candidate.repository';
import { UserCommentRepository } from './postgres/repositories/user-comment-repository';
import { UserComment } from './postgres/models/user-comment.entity';
import { Task } from './postgres/models/task.entity';
import { TaskRepository } from './postgres/repositories/task-repository';
import { ProductEmbedding } from './postgres/models/product-embedding.entity';
import { ProductCategoryEmbedding } from './postgres/models/product-category-embedding.entity';
import { Brand } from './postgres/models/brand.entity';
import { BrandAlias } from './postgres/models/brand-alias.entity';
import { BrandAliasRepository } from './postgres/repositories/brand-alias.repository';
import { BrandRepository } from './postgres/repositories/brand-repository';
import {
  ProductImage,
  ProductImageRepository,
  ProductRating,
  ProductRatingRepository,
  ProductSourceRepository,
  ReviewRepository,
  ScrapeTask,
  ScrapeTaskRepository,
  ThreadSearchTask,
  ThreadSearchTaskRepository,
} from './postgres';
import { ProductSource } from './postgres/models/product-source.entity';
import { ThreadProductCategory } from './postgres/models/thread-product-category.entity';
import { ThreadProductCategoryRepository } from './postgres/repositories/thread-product-category-repository';
import { WebSearchCache } from './postgres/models/web-search-cache.entity';
import { WebSearchCacheRepository } from './postgres/repositories/web-search-cache.repository';
import { ThreadSearchKeyword } from './postgres/models/thread-search-keyword.entity';
import { ThreadSearchKeywordRepository } from './postgres/repositories/thread-search-keyword.repository';
import { ProductDuplicate } from './postgres/models/product-duplicate.entity';
import { ProductDuplicateRepository } from './postgres/repositories/product-duplicate-repository';
import { TranslationCache } from './postgres/models/translation-cache.entity';
import { TranslationCacheRepository } from './postgres/repositories/translation-cache.repository';

export const entityList = [
  Brand,
  BrandAlias,
  ProductAlias,
  ProductCategory,
  ProductCategoryEmbedding,
  ProductModel,
  ProductModelSource,
  ProductEmbedding,
  ProductImage,
  ProductRating,
  ProductReference,
  ProductReferenceCandidate,
  ProductSource,
  UserComment,
  Thread,
  ThreadProductCategory,
  ThreadRun,
  ThreadSearchKeyword,
  Review,
  ReviewFeedback,
  ReviewLabel,
  ScrapeTask,
  Task,
  ThreadSearchTask,
  WebSearchCache,
  ProductDuplicate,
  TranslationCache,
];

@Module({
  imports: [TypeOrmModule.forFeature(entityList, 'postgres')],
  providers: [
    BrandAliasRepository,
    BrandRepository,
    ProductAliasRepository,
    ProductCategoryRepository,
    ProductModelRepository,
    ProductModelSourceRepository,
    ProductRatingRepository,
    ProductReferenceRepository,
    ProductReferenceCandidateRepository,
    ProductImageRepository,
    ProductSourceRepository,
    ReviewRepository,
    ReviewLabelRepository,
    UserCommentRepository,
    ThreadProductCategoryRepository,
    ThreadRepository,
    ThreadRunRepository,
    ThreadSearchKeywordRepository,
    ScrapeTaskRepository,
    TaskRepository,
    ThreadSearchTaskRepository,
    WebSearchCacheRepository,
    ProductDuplicateRepository,
    TranslationCacheRepository,
  ],
  exports: [
    BrandAliasRepository,
    BrandRepository,
    ProductAliasRepository,
    ProductCategoryRepository,
    ProductModelRepository,
    ProductModelSourceRepository,
    ProductRatingRepository,
    ProductReferenceRepository,
    ProductReferenceCandidateRepository,
    ProductImageRepository,
    ProductSourceRepository,
    ReviewRepository,
    ReviewLabelRepository,
    UserCommentRepository,
    ThreadProductCategoryRepository,
    ThreadRepository,
    ThreadRunRepository,
    ThreadSearchKeywordRepository,
    ScrapeTaskRepository,
    TaskRepository,
    ThreadSearchTaskRepository,
    WebSearchCacheRepository,
    ProductDuplicateRepository,
    TranslationCacheRepository,
  ],
})
export class DatabaseModule {}
