import { Module } from '@nestjs/common';
import { ArukeresoSyncService } from './services/arukereso-sync.service';
import { ArukeresoIndexPageService } from './services/arukereso-index-page.service';
import { ArukeresoDetailsPageExtractor } from './services/details/arukereso-details-page-extractor.service';
import { ArukeresoCategoryMapperService } from './services/details/arukereso-category-mapper.service';
import { ArukeresoListPageExtractor } from './services/list/arukereso-list-page-extractor.service';
import { TaskModule } from '@fittkereso-backend/task';
import { ScraperModule } from '@fittkereso-backend/scraper';
import { DatabaseModule } from '@fittkereso-backend/database';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { TranslationModule } from '@fittkereso-backend/translation';
import { ProductScraperModule } from '../product-scraper';
import { ProductModule } from '@fittkereso-backend/product';

@Module({
  imports: [
    DatabaseModule,
    MetricsModule,
    ProductModule,
    ProductScraperModule,
    ScraperModule,
    TaskModule,
    TranslationModule,
  ],
  providers: [
    ArukeresoSyncService,
    ArukeresoIndexPageService,
    ArukeresoDetailsPageExtractor,
    ArukeresoListPageExtractor,
    ArukeresoCategoryMapperService,
  ],
  exports: [
    ArukeresoSyncService,
    ArukeresoDetailsPageExtractor,
    ArukeresoListPageExtractor,
  ],
})
export class ArukeresoModule {}
