import { Module } from '@nestjs/common';
import {
  BrandSearchService,
  ProductDuplicationSearchService,
  ProductDuplicateSearchService,
  ProductSourceSearchService,
  ProductCategorySearchService,
  ProductSearchService,
  ScrapeTaskSearchService,
  SellerSearchService,
  TaskSearchService,
  OfferSearchService,
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
    SellerSearchService,
    TaskSearchService,
    OfferSearchService,
  ],
  exports: [
    BrandSearchService,
    ProductDuplicationSearchService,
    ProductDuplicateSearchService,
    ProductSourceSearchService,
    ProductCategorySearchService,
    ProductSearchService,
    ScrapeTaskSearchService,
    SellerSearchService,
    TaskSearchService,
    OfferSearchService,
  ],
})
export class SearchModule {}
