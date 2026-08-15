import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductModel } from './postgres/models/product-model.entity';
import { ProductCategory } from './postgres/models/product-category.entity';
import { ProductAlias } from './postgres/models/product-alias.entity';
import { ProductCategoryRepository } from './postgres/repositories/product-category-repository';
import { ProductModelRepository } from './postgres/repositories/product-model-repository';
import { ProductModelSource } from './postgres/models/product-model-source.entity';
import { ProductModelSourceRepository } from './postgres/repositories/product-model-source-repository';
import { ProductAliasRepository } from './postgres/repositories/product-alias-repository';
import { Task } from './postgres/models/task.entity';
import { TaskRepository } from './postgres/repositories/task-repository';
import { ProductEmbedding } from './postgres/models/product-embedding.entity';
import { Brand } from './postgres/models/brand.entity';
import { BrandAlias } from './postgres/models/brand-alias.entity';
import { BrandAliasRepository } from './postgres/repositories/brand-alias.repository';
import { BrandRepository } from './postgres/repositories/brand-repository';
import {
  ProductImage,
  ProductImageRepository,
  ProductSourceRepository,
  ScrapeTask,
  ScrapeTaskRepository,
} from './postgres';
import { ProductSource } from './postgres/models/product-source.entity';
import { ProductDuplicate } from './postgres/models/product-duplicate.entity';
import { ProductDuplicateRepository } from './postgres/repositories/product-duplicate-repository';
import { TranslationCache } from './postgres/models/translation-cache.entity';
import { TranslationCacheRepository } from './postgres/repositories/translation-cache.repository';
import { Seller } from './postgres/models/seller.entity';
import { SellerRepository } from './postgres/repositories/seller-repository';
import { BillingInfo } from './postgres/models/billing-info.entity';
import { BillingInfoRepository } from './postgres/repositories/billing-info-repository';
import { Offer } from './postgres/models/offer.entity';
import { OfferRepository } from './postgres/repositories/offer-repository';
import { PriceHistory } from './postgres/models/price-history.entity';
import { PriceHistoryRepository } from './postgres/repositories/price-history-repository';

export const entityList = [
  Brand,
  BrandAlias,
  ProductAlias,
  ProductCategory,
  ProductModel,
  ProductModelSource,
  ProductEmbedding,
  ProductImage,
  ProductSource,
  ScrapeTask,
  Task,
  ProductDuplicate,
  TranslationCache,
  Seller,
  BillingInfo,
  Offer,
  PriceHistory,
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
    ProductImageRepository,
    ProductSourceRepository,
    ScrapeTaskRepository,
    TaskRepository,
    ProductDuplicateRepository,
    TranslationCacheRepository,
    SellerRepository,
    BillingInfoRepository,
    OfferRepository,
    PriceHistoryRepository,
  ],
  exports: [
    BrandAliasRepository,
    BrandRepository,
    ProductAliasRepository,
    ProductCategoryRepository,
    ProductModelRepository,
    ProductModelSourceRepository,
    ProductImageRepository,
    ProductSourceRepository,
    ScrapeTaskRepository,
    TaskRepository,
    ProductDuplicateRepository,
    TranslationCacheRepository,
    SellerRepository,
    BillingInfoRepository,
    OfferRepository,
    PriceHistoryRepository,
  ],
})
export class DatabaseModule {}
