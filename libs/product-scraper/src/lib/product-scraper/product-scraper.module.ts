import { Module } from '@nestjs/common';
import { ProductDetailsPageScraperService } from './services/product-details-page-scraper.service';
import { ProductListPageScraperService } from './services/product-list-page-scraper.service';
import { ScraperModule } from '@fittkereso-backend/scraper';
import { ProductScrapeUpdaterService } from './services/product-scrape-updater.service';
import { ScrapeUrlDeduplicationService } from './services/scrape-url-deduplication.service';
import { GenericProductSourceSyncService } from './services/generic-product-source-sync.service';
import { ProductSourceSimulationService } from './services/product-source-simulation.service';
import { TaskModule } from '@fittkereso-backend/task';
import { ResolutionModule } from '@fittkereso-backend/resolution';
import { AiModule } from '@fittkereso-backend/ai';
import { DatabaseModule } from '@fittkereso-backend/database';
import { StorageModule } from '@fittkereso-backend/storage';
import { HttpModule } from '@nestjs/axios';
import { ProductModule } from '@fittkereso-backend/product';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { ScrapeInterpreterModule } from '@fittkereso-backend/scrape-interpreter';
import { TranslationModule } from '@fittkereso-backend/translation';

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
    ScrapeInterpreterModule,
    TranslationModule,
  ],
  providers: [
    ProductDetailsPageScraperService,
    ProductListPageScraperService,
    ProductScrapeUpdaterService,
    ScrapeUrlDeduplicationService,
    GenericProductSourceSyncService,
    ProductSourceSimulationService,
  ],
  exports: [
    ProductDetailsPageScraperService,
    ProductListPageScraperService,
    ScrapeUrlDeduplicationService,
    GenericProductSourceSyncService,
    ProductSourceSimulationService,
  ],
})
export class ProductScraperModule {}
