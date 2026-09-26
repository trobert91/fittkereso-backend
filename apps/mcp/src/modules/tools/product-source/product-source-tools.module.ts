import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ProductModule } from '@fittkereso-backend/product';
import { SearchModule } from '@fittkereso-backend/search';
import { ScraperModule } from '@fittkereso-backend/scraper';
import { ProductScraperModule } from '@fittkereso-backend/product-scraper';
import { AiModule } from '@fittkereso-backend/ai';
import { TaskModule } from '@fittkereso-backend/task';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { McpModule } from '@rekog/mcp-nest';
import { ProductSourceTools } from './product-source.tools';
import { ProductSourceConfigGeneratorTools } from './product-source-config-generator.tools';
import { ProductSourceSimulateScrapeTools } from './product-source-simulate-scrape.tools';
import { ProductSourceSimulateImportTools } from './product-source-simulate-import.tools';
import { SellerTools } from './seller.tools';
import { ScrapeRunTools } from './scrape-run.tools';
import { ProductSourceRecordsTools } from './product-source-records.tools';
import { OfferSweepTools } from './offer-sweep.tools';

@Module({
  imports: [
    DatabaseModule,
    DynamicConfigModule,
    ProductModule,
    SearchModule,
    ScraperModule,
    ProductScraperModule,
    AiModule,
    TaskModule,
    McpModule.forFeature(
      [
        ProductSourceTools,
        ProductSourceConfigGeneratorTools,
        ProductSourceSimulateScrapeTools,
        ProductSourceSimulateImportTools,
        SellerTools,
        ScrapeRunTools,
        ProductSourceRecordsTools,
        OfferSweepTools,
      ],
      'fittkereso',
    ),
  ],
  providers: [
    OfferSweepTools,
    ProductSourceTools,
    ProductSourceConfigGeneratorTools,
    ProductSourceSimulateScrapeTools,
    ProductSourceSimulateImportTools,
    SellerTools,
    ScrapeRunTools,
    ProductSourceRecordsTools,
  ],
})
export class ProductSourceToolsModule {}
