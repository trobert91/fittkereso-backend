import { Module } from '@nestjs/common';
import {
  BrandSearchService,
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
