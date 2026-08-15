import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ExaModule } from '@fittkereso-backend/exa';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { TaskModule } from '@fittkereso-backend/task';
import { ScrapeInterpreterModule } from '@fittkereso-backend/scrape-interpreter';
import { IncrementalSyncService } from './incremental-sync.service';
import { ProductScraperModule } from '../product-scraper';

@Module({
  imports: [
    DatabaseModule,
    ExaModule,
    MetricsModule,
    TaskModule,
    ProductScraperModule,
    ScrapeInterpreterModule,
  ],
  providers: [IncrementalSyncService],
  exports: [IncrementalSyncService],
})
export class IncrementalSyncModule {}
