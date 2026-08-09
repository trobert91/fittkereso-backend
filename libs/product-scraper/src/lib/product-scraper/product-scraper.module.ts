import { Module } from "@nestjs/common";
import { ProductDetailsPageScraperService } from "./services/product-details-page-scraper.service";
import { ProductListPageScraperService } from "./services/product-list-page-scraper.service";
import { ScraperModule } from "@ebike-backend/scraper";
import { ProductScrapeUpdaterService } from "./services/product-scrape-updater.service";
import { ScrapeUrlDeduplicationService } from "./services/scrape-url-deduplication.service";
import { TaskModule } from "@ebike-backend/task";
import { ResolutionModule } from "@ebike-backend/resolution";
import { AiModule } from "@ebike-backend/ai";
import { DatabaseModule } from "@ebike-backend/database";
import { ProductValueMapperService } from "./services/product-value-mapper.service";
import { StorageModule } from "@ebike-backend/storage";
import { HttpModule } from "@nestjs/axios";
import { ProductModule } from "@ebike-backend/product";
import { MetricsModule } from "@ebike-backend/metrics";

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
