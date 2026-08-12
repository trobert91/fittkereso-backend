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
import { ProductCategoryEmbedding } from './postgres/models/product-category-embedding.entity';
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
import { WebSearchCache } from './postgres/models/web-search-cache.entity';
import { WebSearchCacheRepository } from './postgres/repositories/web-search-cache.repository';
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
  ProductSource,
  ScrapeTask,
  Task,
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
    ProductImageRepository,
    ProductSourceRepository,
    ScrapeTaskRepository,
    TaskRepository,
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
    ProductImageRepository,
    ProductSourceRepository,
    ScrapeTaskRepository,
    TaskRepository,
    WebSearchCacheRepository,
    ProductDuplicateRepository,
    TranslationCacheRepository,
  ],
})
export class DatabaseModule {}
