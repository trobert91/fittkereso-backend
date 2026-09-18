import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductModel } from './postgres/models/product-model.entity';
import { ProductCategory } from './postgres/models/product-category.entity';
import { ProductAlias } from './postgres/models/product-alias.entity';
import { ProductCategoryRepository } from './postgres/repositories/product-category-repository';
import { ProductModelRepository } from './postgres/repositories/product-model-repository';
import { ProductSourceRecord } from './postgres/models/product-source-record.entity';
import { ProductSourceRecordRepository } from './postgres/repositories/product-source-record-repository';
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
import { ProductDuplicatePair } from './postgres/models/product-duplicate-pair.entity';
import { ProductDuplicatePairRepository } from './postgres/repositories/product-duplicate-pair-repository';
import { User } from './postgres/models/user.entity';
import { UserRepository } from './postgres/repositories/user-repository';
import { ProductSourceConfigValidatorService } from './postgres/services/product-source-config-validator.service';
import { ProductSourceVersion } from './postgres/models/product-source-version.entity';
import { ProductSourceVersionRepository } from './postgres/repositories/product-source-version-repository';
import { ProductSourceAction } from './postgres/models/product-source-action.entity';
import { ProductSourceActionRepository } from './postgres/repositories/product-source-action-repository';

export const entityList = [
  Brand,
  BrandAlias,
  ProductAlias,
  ProductCategory,
  ProductModel,
  ProductSourceRecord,
  ProductEmbedding,
  ProductImage,
  ProductSource,
  ScrapeTask,
  Task,
  TranslationCache,
  Seller,
  BillingInfo,
  Offer,
  PriceHistory,
  ProductDuplicatePair,
  User,
  ProductSourceVersion,
  ProductSourceAction,
];

@Module({
  imports: [TypeOrmModule.forFeature(entityList, 'postgres')],
  providers: [
    BrandAliasRepository,
    BrandRepository,
    ProductAliasRepository,
    ProductCategoryRepository,
    ProductModelRepository,
    ProductSourceRecordRepository,
    ProductImageRepository,
    ProductSourceRepository,
    ScrapeTaskRepository,
    TaskRepository,
    TranslationCacheRepository,
    SellerRepository,
    BillingInfoRepository,
    OfferRepository,
    PriceHistoryRepository,
    ProductDuplicatePairRepository,
    UserRepository,
    ProductSourceConfigValidatorService,
    ProductSourceVersionRepository,
    ProductSourceActionRepository,
  ],
  exports: [
    BrandAliasRepository,
    BrandRepository,
    ProductAliasRepository,
    ProductCategoryRepository,
    ProductModelRepository,
    ProductSourceRecordRepository,
    ProductImageRepository,
    ProductSourceRepository,
    ScrapeTaskRepository,
    TaskRepository,
    TranslationCacheRepository,
    SellerRepository,
    BillingInfoRepository,
    OfferRepository,
    PriceHistoryRepository,
    ProductDuplicatePairRepository,
    UserRepository,
    ProductSourceConfigValidatorService,
    ProductSourceVersionRepository,
    ProductSourceActionRepository,
  ],
})
export class DatabaseModule {}
