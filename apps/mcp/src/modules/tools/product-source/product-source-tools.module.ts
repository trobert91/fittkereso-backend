import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ProductModule } from '@fittkereso-backend/product';
import { SearchModule } from '@fittkereso-backend/search';
import { ScraperModule } from '@fittkereso-backend/scraper';
import { AiModule } from '@fittkereso-backend/ai';
import { McpModule } from '@rekog/mcp-nest';
import { ProductSourceTools } from './product-source.tools';
import { ProductSourceConfigGeneratorTools } from './product-source-config-generator.tools';

@Module({
  imports: [
    DatabaseModule,
    ProductModule,
    SearchModule,
    ScraperModule,
    AiModule,
    McpModule.forFeature(
      [ProductSourceTools, ProductSourceConfigGeneratorTools],
      'fittkereso',
    ),
  ],
  providers: [ProductSourceTools, ProductSourceConfigGeneratorTools],
})
export class ProductSourceToolsModule {}
