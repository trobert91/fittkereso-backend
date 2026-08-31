import { Module } from '@nestjs/common';
import {
  BrandSearchService,
  ProductDuplicationSearchService,
  ProductResolutionSearchService,
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
    ProductResolutionSearchService,
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
    ProductResolutionSearchService,
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
