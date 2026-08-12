import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ExaModule } from '@fittkereso-backend/exa';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { TaskModule } from '@fittkereso-backend/task';
import { IncrementalSyncService } from './incremental-sync.service';
import { ArukeresoUrlClassifier } from './classifiers/arukereso-url-classifier';
import { DisplayspecsUrlClassifier } from './classifiers/displayspecs-url-classifier';
import { ProductScraperModule } from '../product-scraper';

@Module({
  imports: [
    DatabaseModule,
    ExaModule,
    MetricsModule,
    TaskModule,
    ProductScraperModule,
  ],
  providers: [
    IncrementalSyncService,
    ArukeresoUrlClassifier,
    DisplayspecsUrlClassifier,
  ],
  exports: [IncrementalSyncService],
})
export class IncrementalSyncModule {}
