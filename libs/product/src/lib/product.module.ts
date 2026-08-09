import { Module } from "@nestjs/common";
import { DatabaseModule } from "@ebike-backend/database";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";
import { StorageModule } from "@ebike-backend/storage";
import { DataforseoModule } from "@ebike-backend/dataforseo";
import { ExaModule } from "@ebike-backend/exa";
import { ProductImageDtoService } from "./services/product-image-dto.service";
import { ProductSpecMergeService } from "./services/product-spec/product-spec-merge.service";
import { ProductSpecSortService } from "./services/product-spec/product-spec-sort.service";
import {
  BrandCacheService,
  BrandCreateService,
  BrandDetailService,
  BrandUpdateService,
  CategoryCacheService,
  ProductCategoryDetailService,
  ProductCategoryUpdateService,
  ProductEmbeddingService,
  ProductImageCopyService,
  ProductImageDeleteService,
  ProductImageOrderService,
  ProductImageUploadService,
  ProductNormalizerService,
  ProductSpecContextService,
  ProductSpecNormalizationService,
  ProductSpecUpdaterService,
  ProductSpecValidatorService,
  SpecExtractionService,
} from "./services";
import { ProductDetailService } from "./services/product-detail.service";
import { ProductUpdateService } from "./services/update/product-update.service";
import { ProductUpdateMapperService } from "./services/update/product-update-mapper.service";
import { AiModule } from "@ebike-backend/ai";
import { ProductImageStorageService } from "./services/image/product-image-storage.service";
import { ProductImageFactory } from "./services/image/product-image-factory";
import { HttpModule } from "@nestjs/axios";
import { CategoryUpdateMapperService } from "./services/category/category-update-mapper.service";
import { DebugModule } from "@ebike-backend/debug";
import { MetricsModule } from "@ebike-backend/metrics";
import { ProductRatingUpdaterService } from "./services/rating";
import { ProductReviewAnalysisService } from "./services/analysis";
import { ProductMergeService } from "./services/merge/product-merge.service";
import { SpecComparisonService } from "./services/duplicate/spec-comparison.service";
import { ProductDuplicateEvaluationService } from "./services/duplicate/product-duplicate-evaluation.service";
import { SimilarityInputNormalizationService } from "./services/similarity/similarity-input-normalization.service";
import { ProductSimilarityService } from "./services/similarity/product-similarity.service";
import { SearchModule } from "@ebike-backend/search";
import { BrandResolutionService } from "./services/resolution/brand-resolution.service";
import { CategoryNameMatcherService } from "./services/resolution/category-name-matcher.service";
import { ProductAliasAutoCreateService } from "./services/resolution/product-alias-auto-create.service";
import { ProductEmbeddingMatchService } from "./services/resolution/product-embedding-match.service";
import { ProductFuzzySearchService } from "./services/resolution/product-fuzzy-search.service";
import { ProductWebSearchService } from "./services/resolution/product-web-search.service";

@Module({
  imports: [
    DatabaseModule,
    DataforseoModule,
    DebugModule,
    DynamicConfigModule,
    ExaModule,
    HttpModule,
    MetricsModule,
    AiModule,
    SearchModule,
    StorageModule,
  ],
  controllers: [],
  providers: [
    ProductImageDtoService,
    ProductSpecMergeService,
    ProductSpecSortService,
    ProductSpecUpdaterService,
    ProductCategoryUpdateService,
    ProductDetailService,
    ProductUpdateService,
    ProductUpdateMapperService,
    ProductImageUploadService,
    ProductImageCopyService,
    ProductImageStorageService,
    ProductImageFactory,
    ProductImageOrderService,
    ProductImageDeleteService,
    ProductSpecValidatorService,
    ProductSpecNormalizationService,
    ProductCategoryDetailService,
    CategoryUpdateMapperService,
    BrandCacheService,
    BrandCreateService,
    BrandDetailService,
    BrandUpdateService,
    CategoryCacheService,
    ProductSpecContextService,
    ProductNormalizerService,
    ProductEmbeddingService,
    ProductRatingUpdaterService,
    ProductReviewAnalysisService,
    ProductMergeService,
    SpecExtractionService,
    SpecComparisonService,
    ProductDuplicateEvaluationService,
    SimilarityInputNormalizationService,
    ProductSimilarityService,
    BrandResolutionService,
    CategoryNameMatcherService,
    ProductAliasAutoCreateService,
    ProductEmbeddingMatchService,
    ProductFuzzySearchService,
    ProductWebSearchService,
  ],
  exports: [
    ProductImageDtoService,
    ProductSpecMergeService,
    ProductSpecSortService,
    ProductCategoryUpdateService,
    ProductDetailService,
    ProductUpdateService,
    ProductImageUploadService,
    ProductImageCopyService,
    ProductImageOrderService,
    ProductImageDeleteService,
    ProductSpecUpdaterService,
    ProductSpecValidatorService,
    ProductSpecNormalizationService,
    ProductCategoryDetailService,
    BrandCacheService,
    BrandCreateService,
    BrandDetailService,
    BrandUpdateService,
    CategoryCacheService,
    ProductSpecContextService,
    ProductNormalizerService,
    ProductEmbeddingService,
    ProductRatingUpdaterService,
    ProductReviewAnalysisService,
    ProductMergeService,
    SpecExtractionService,
    SpecComparisonService,
    ProductDuplicateEvaluationService,
    SimilarityInputNormalizationService,
    ProductSimilarityService,
    BrandResolutionService,
    CategoryNameMatcherService,
    ProductAliasAutoCreateService,
    ProductEmbeddingMatchService,
    ProductFuzzySearchService,
    ProductWebSearchService,
  ],
})
export class ProductModule {}
