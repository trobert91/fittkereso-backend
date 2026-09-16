import { Module } from '@nestjs/common';
import { ScrapeTestController } from './controllers/scrape-test.controller';
import { ScraperModule } from '@fittkereso-backend/scraper';
import { ProductSourceTestController } from './controllers/product-source-test.controller';
import { TaskModule } from '@fittkereso-backend/task';
import { ProductModule } from '@fittkereso-backend/product';
import { DatabaseModule } from '@fittkereso-backend/database';

@Module({
  imports: [DatabaseModule, TaskModule, ProductModule, ScraperModule],
  controllers: [ScrapeTestController, ProductSourceTestController],
})
export class TestModule {}
