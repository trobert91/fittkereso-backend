import { Module } from '@nestjs/common';
import { ScrapeTestController } from './controllers/scrape-test.controller';
import { ScraperModule } from '@fittkereso-backend/scraper';
import { ProductSourceTestController } from './controllers/product-source-test.controller';
import { TaskModule } from '@fittkereso-backend/task';
import { ResolutionModule } from '@fittkereso-backend/resolution';
import { ProductModule } from '@fittkereso-backend/product';
import { ProductTestController } from './controllers/product-test.controller';
import { DatabaseModule } from '@fittkereso-backend/database';

@Module({
  imports: [
    DatabaseModule,
    TaskModule,
    ProductModule,
    ResolutionModule,
    ScraperModule,
  ],
  controllers: [
    ScrapeTestController,
    ProductSourceTestController,
    ProductTestController,
  ],
})
export class TestModule {}
