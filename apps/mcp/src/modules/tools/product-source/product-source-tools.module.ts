import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ProductModule } from '@fittkereso-backend/product';
import { SearchModule } from '@fittkereso-backend/search';
import { ScraperModule } from '@fittkereso-backend/scraper';
import { AiModule } from '@fittkereso-backend/ai';
import { TaskModule } from '@fittkereso-backend/task';
import { McpModule } from '@rekog/mcp-nest';
import { ProductSourceTools } from './product-source.tools';
import { ProductSourceConfigGeneratorTools } from './product-source-config-generator.tools';
import { SellerTools } from './seller.tools';
import { ScrapeRunTools } from './scrape-run.tools';

@Module({
  imports: [
    DatabaseModule,
    ProductModule,
    SearchModule,
    ScraperModule,
    AiModule,
    TaskModule,
    McpModule.forFeature(
      [
        ProductSourceTools,
        ProductSourceConfigGeneratorTools,
        SellerTools,
        ScrapeRunTools,
      ],
      'fittkereso',
    ),
  ],
  providers: [
    ProductSourceTools,
    ProductSourceConfigGeneratorTools,
    SellerTools,
    ScrapeRunTools,
  ],
})
export class ProductSourceToolsModule {}
