import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { StorageModule } from '@fittkereso-backend/storage';
import { DataforseoModule } from '@fittkereso-backend/dataforseo';
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
  ProductSourceRecordUpdaterService,
} from './services';
import { ProductNameMergeService } from './services/product-name/product-name-merge.service';
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
import { ProductSplitService } from './services/merge/product-split.service';
import { ProductDescriptionService } from './services/product-description/product-description.service';
import { ProductModelFactoryService } from './services/product-model-factory.service';
import { SearchModule } from '@fittkereso-backend/search';
import { BrandResolutionService } from './services/brand/brand-resolution.service';
import { OfferMatchingService } from './services/offer/offer-matching.service';
import { OfferFreshnessService } from './services/offer/offer-freshness.service';
import { OfferComposerService } from './services/offer/offer-composer.service';
import { StaleOfferSweepService } from './services/offer/stale-offer-sweep.service';
import { ContributorDetachService } from './services/offer/contributor-detach.service';
import { CompleteSourceRemovalService } from './services/offer/complete-source-removal.service';
import { SellerCreateService } from './services/seller/seller-create.service';
import { SellerDetailService } from './services/seller/seller-detail.service';
import { SellerProductSourceCreateService } from './services/seller/seller-product-source-create.service';
import { SellerUpdateService } from './services/seller/seller-update.service';
import { ProductSourceUpdateService } from './services/product-source/product-source-update.service';
import { ProductSourceSellerRulesService } from './services/product-source/product-source-seller-rules.service';
import { ProductSourceVersionService } from './services/product-source/product-source-version.service';

@Module({
  imports: [
    DatabaseModule,
    DataforseoModule,
    DebugModule,
    DynamicConfigModule,
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
    ProductDescriptionService,
    ProductSplitService,
    ProductModelFactoryService,
    ProductNameMergeService,
    ProductSourceRecordUpdaterService,
    SpecExtractionService,
    ProductSourcePostProcessService,
    ProductSourcePostProcessMergeService,
    BrandResolutionService,
    OfferMatchingService,
    OfferFreshnessService,
    OfferComposerService,
    ContributorDetachService,
    CompleteSourceRemovalService,
    StaleOfferSweepService,
    SellerCreateService,
    SellerDetailService,
    SellerProductSourceCreateService,
    SellerUpdateService,
    ProductSourceUpdateService,
    ProductSourceSellerRulesService,
    ProductSourceVersionService,
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
    ProductDescriptionService,
    ProductSplitService,
    ProductModelFactoryService,
    ProductNameMergeService,
    ProductSourceRecordUpdaterService,
    SpecExtractionService,
    ProductSourcePostProcessService,
    ProductSourcePostProcessMergeService,
    BrandResolutionService,
    OfferMatchingService,
    OfferFreshnessService,
    OfferComposerService,
    ContributorDetachService,
    CompleteSourceRemovalService,
    StaleOfferSweepService,
    SellerCreateService,
    SellerDetailService,
    SellerProductSourceCreateService,
    SellerUpdateService,
    ProductSourceUpdateService,
    ProductSourceSellerRulesService,
    ProductSourceVersionService,
  ],
})
export class ProductModule {}
