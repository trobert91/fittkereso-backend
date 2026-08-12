import { Module } from '@nestjs/common';
import {
  BrandSearchService,
  ProductDuplicationSearchService,
  ProductDuplicateSearchService,
  ProductSourceSearchService,
  ProductCategorySearchService,
  ProductSearchService,
  ScrapeTaskSearchService,
  TaskSearchService,
} from './services';
import { DatabaseModule } from '@fittkereso-backend/database';

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
    ScrapeTaskSearchService,
    TaskSearchService,
  ],
  exports: [
    BrandSearchService,
    ProductDuplicationSearchService,
    ProductDuplicateSearchService,
    ProductSourceSearchService,
    ProductCategorySearchService,
    ProductSearchService,
    ScrapeTaskSearchService,
    TaskSearchService,
  ],
})
export class SearchModule {}
