import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { StorageModule } from '@fittkereso-backend/storage';
import { DataforseoModule } from '@fittkereso-backend/dataforseo';
import { ExaModule } from '@fittkereso-backend/exa';
import { ProductImageDtoService } from './services/product-image-dto.service';
import { ProductSpecMergeService } from './services/product-spec/product-spec-merge.service';
import { ProductSpecSortService } from './services/product-spec/product-spec-sort.service';
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
  SpecTranslationSelectorService,
  ProductSourcePostProcessService,
  ProductSourcePostProcessMergeService,
} from './services';
import { ProductDetailService } from './services/product-detail.service';
import { ProductUpdateService } from './services/update/product-update.service';
import { ProductUpdateMapperService } from './services/update/product-update-mapper.service';
import { AiModule } from '@fittkereso-backend/ai';
import { ProductImageStorageService } from './services/image/product-image-storage.service';
import { ProductImageFactory } from './services/image/product-image-factory';
import { HttpModule } from '@nestjs/axios';
import { CategoryUpdateMapperService } from './services/category/category-update-mapper.service';
import { DebugModule } from '@fittkereso-backend/debug';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { ProductMergeService } from './services/merge/product-merge.service';
import { SpecComparisonService } from './services/duplicate/spec-comparison.service';
import { ProductDuplicateEvaluationService } from './services/duplicate/product-duplicate-evaluation.service';
import { SimilarityInputNormalizationService } from './services/similarity/similarity-input-normalization.service';
import { ProductSimilarityService } from './services/similarity/product-similarity.service';
import { SearchModule } from '@fittkereso-backend/search';
import { BrandResolutionService } from './services/resolution/brand-resolution.service';
import { CategoryNameMatcherService } from './services/resolution/category-name-matcher.service';
import { ProductAliasAutoCreateService } from './services/resolution/product-alias-auto-create.service';
import { ProductEmbeddingMatchService } from './services/resolution/product-embedding-match.service';
import { ProductFuzzySearchService } from './services/resolution/product-fuzzy-search.service';
import { ProductWebSearchService } from './services/resolution/product-web-search.service';
import { SellerResolutionService } from './services/resolution/seller-resolution.service';
import { SellerCreateService } from './services/seller/seller-create.service';
import { SellerDetailService } from './services/seller/seller-detail.service';
import { SellerProductSourceCreateService } from './services/seller/seller-product-source-create.service';
import { SellerUpdateService } from './services/seller/seller-update.service';
import { ProductSourceUpdateService } from './services/product-source/product-source-update.service';

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
    SpecTranslationSelectorService,
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
    ProductMergeService,
    SpecExtractionService,
    ProductSourcePostProcessService,
    ProductSourcePostProcessMergeService,
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
    SellerResolutionService,
    SellerCreateService,
    SellerDetailService,
    SellerProductSourceCreateService,
    SellerUpdateService,
    ProductSourceUpdateService,
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
    SpecTranslationSelectorService,
    ProductCategoryDetailService,
    BrandCacheService,
    BrandCreateService,
    BrandDetailService,
    BrandUpdateService,
    CategoryCacheService,
    ProductSpecContextService,
    ProductNormalizerService,
    ProductEmbeddingService,
    ProductMergeService,
    SpecExtractionService,
    ProductSourcePostProcessService,
    ProductSourcePostProcessMergeService,
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
    SellerResolutionService,
    SellerCreateService,
    SellerDetailService,
    SellerProductSourceCreateService,
    SellerUpdateService,
    ProductSourceUpdateService,
  ],
})
export class ProductModule {}
