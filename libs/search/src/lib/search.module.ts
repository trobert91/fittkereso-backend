import { Module } from '@nestjs/common';
import {
  BrandSearchService,
  ProductSourceSearchService,
  ProductCategorySearchService,
  ProductDuplicatePairSearchService,
  ProductSearchService,
  ProductImportTaskSearchService,
  ProductSourceRecordSearchService,
  SellerSearchService,
  TaskSearchService,
  OfferSearchService,
  UserSearchService,
} from './services';
import { DatabaseModule } from '@fittkereso-backend/database';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';

@Module({
  imports: [DatabaseModule, DynamicConfigModule],
  controllers: [],
  providers: [
    BrandSearchService,
    ProductSourceSearchService,
    ProductCategorySearchService,
    ProductDuplicatePairSearchService,
    ProductSearchService,
    ProductImportTaskSearchService,
    ProductSourceRecordSearchService,
    SellerSearchService,
    TaskSearchService,
    OfferSearchService,
    UserSearchService,
  ],
  exports: [
    BrandSearchService,
    ProductSourceSearchService,
    ProductCategorySearchService,
    ProductDuplicatePairSearchService,
    ProductSearchService,
    ProductImportTaskSearchService,
    ProductSourceRecordSearchService,
    SellerSearchService,
    TaskSearchService,
    OfferSearchService,
    UserSearchService,
  ],
})
export class SearchModule {}
