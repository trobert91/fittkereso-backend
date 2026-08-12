import { Module } from '@nestjs/common';
import { ProductDetailsPageScraperService } from './services/product-details-page-scraper.service';
import { ProductListPageScraperService } from './services/product-list-page-scraper.service';
import { ScraperModule } from '@fittkereso-backend/scraper';
import { ProductScrapeUpdaterService } from './services/product-scrape-updater.service';
import { ScrapeUrlDeduplicationService } from './services/scrape-url-deduplication.service';
import { TaskModule } from '@fittkereso-backend/task';
import { ResolutionModule } from '@fittkereso-backend/resolution';
import { AiModule } from '@fittkereso-backend/ai';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ProductValueMapperService } from './services/product-value-mapper.service';
import { StorageModule } from '@fittkereso-backend/storage';
import { HttpModule } from '@nestjs/axios';
import { ProductModule } from '@fittkereso-backend/product';
import { MetricsModule } from '@fittkereso-backend/metrics';

@Module({
  imports: [
    DatabaseModule,
    ResolutionModule,
    ProductModule,
    AiModule,
    ScraperModule,
    StorageModule,
    TaskModule,
    HttpModule,
    MetricsModule,
  ],
  providers: [
    ProductDetailsPageScraperService,
    ProductListPageScraperService,
    ProductScrapeUpdaterService,
    ScrapeUrlDeduplicationService,
    ProductValueMapperService,
  ],
  exports: [
    ProductDetailsPageScraperService,
    ProductListPageScraperService,
    ProductValueMapperService,
    ScrapeUrlDeduplicationService,
  ],
})
export class ProductScraperModule {}
