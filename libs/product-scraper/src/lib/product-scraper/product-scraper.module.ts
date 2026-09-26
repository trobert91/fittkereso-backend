import { Module, OnModuleInit } from '@nestjs/common';
import { ProductDetailsPageScraperService } from './services/product-details-page-scraper.service';
import { ProductListPageScraperService } from './services/product-list-page-scraper.service';
import { ScraperModule } from '@fittkereso-backend/scraper';
import { ProductScrapeUpdaterService } from './services/product-scrape-updater.service';
import { ScrapeUrlDeduplicationService } from './services/scrape-url-deduplication.service';
import { ListProductRefreshService } from './services/list-product-refresh.service';
import { DetailTaskCapService } from './services/detail-task-cap.service';
import { ScrapingImportService } from './services/scraping-import.service';
import { ProductSourceImporterRegistry } from './services/product-source-importer-registry.service';
import { ProductSourceSimulationService } from './services/product-source-simulation.service';
import { ProductSourceImportSimulationService } from './services/product-source-import-simulation.service';
import { SpecPostProcessService } from './services/spec-post-process.service';
import { ArukeresoFeedParserService } from '../arukereso/arukereso-feed-parser.service';
import { ArukeresoProductMapperService } from '../arukereso/arukereso-product-mapper.service';
import { ArukeresoImportService } from '../arukereso/arukereso-import.service';
import { ArukeresoFeedTriageService } from '../arukereso/arukereso-feed-triage.service';
import { ArukeresoFeedConfirmService } from '../arukereso/arukereso-feed-confirm.service';
import { ArukeresoFeedEntryService } from '../arukereso/arukereso-feed-entry.service';
import { TaskModule } from '@fittkereso-backend/task';
import { ProductIdentityModule } from '@fittkereso-backend/product-identity';
import { AiModule } from '@fittkereso-backend/ai';
import { DatabaseModule } from '@fittkereso-backend/database';
import { StorageModule } from '@fittkereso-backend/storage';
import { HttpModule } from '@nestjs/axios';
import { ProductModule } from '@fittkereso-backend/product';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { ScrapeInterpreterModule } from '@fittkereso-backend/scrape-interpreter';
import { TranslationModule } from '@fittkereso-backend/translation';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';

@Module({
  imports: [
    DatabaseModule,
    ProductIdentityModule,
    ProductModule,
    AiModule,
    ScraperModule,
    StorageModule,
    TaskModule,
    HttpModule,
    MetricsModule,
    ScrapeInterpreterModule,
    TranslationModule,
    DynamicConfigModule,
  ],
  providers: [
    ProductDetailsPageScraperService,
    ProductListPageScraperService,
    ProductScrapeUpdaterService,
    ScrapeUrlDeduplicationService,
    ListProductRefreshService,
    DetailTaskCapService,
    ScrapingImportService,
    SpecPostProcessService,
    ArukeresoFeedParserService,
    ArukeresoProductMapperService,
    ArukeresoImportService,
    ArukeresoFeedTriageService,
    ArukeresoFeedConfirmService,
    ArukeresoFeedEntryService,
    ProductSourceImporterRegistry,
    ProductSourceSimulationService,
    ProductSourceImportSimulationService,
  ],
  exports: [
    ProductDetailsPageScraperService,
    ProductListPageScraperService,
    ScrapeUrlDeduplicationService,
    ListProductRefreshService,
    ScrapingImportService,
    ArukeresoFeedParserService,
    ArukeresoImportService,
    ArukeresoFeedEntryService,
    ProductSourceImporterRegistry,
    ProductSourceSimulationService,
    ProductSourceImportSimulationService,
  ],
})
export class ProductScraperModule implements OnModuleInit {
  constructor(
    private readonly registry: ProductSourceImporterRegistry,
    private readonly scrapingImporter: ScrapingImportService,
    private readonly arukeresoImporter: ArukeresoImportService,
  ) {}

  // Registered here rather than self-registering in each importer, so the
  // full set is visible in one place and the registry/type parity spec has
  // something to assert against.
  onModuleInit(): void {
    this.registry.register(this.scrapingImporter);
    this.registry.register(this.arukeresoImporter);
  }
}
