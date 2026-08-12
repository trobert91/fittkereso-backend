import { Module } from '@nestjs/common';
import { DatabaseModule } from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { ProductModule } from '@fittkereso-backend/product';
import { TaskModule } from '@fittkereso-backend/task';
import { ScraperModule } from '@fittkereso-backend/scraper';
import { DisplayspecsSyncService } from './services/displayspecs-sync.service';
import { DisplaySpecsIndexPageService } from './services/displayspecs-index-page.service';
import { DisplayspecsDetailsPageExtractor } from './services/details/displayspecs-details-extractor.service';
import { DisplayspecsCategoryMapperService } from './services/details/displayspecs-category-mapper.service';
import { DisplayspecsListPageExtractor } from './services/list/displayspecs-list-page-extractor.service';
import { ProductScraperModule } from '../product-scraper';

@Module({
  imports: [
    DatabaseModule,
    MetricsModule,
    ProductModule,
    ProductScraperModule,
    ScraperModule,
    TaskModule,
  ],
  providers: [
    CategoryConfigService,
    DisplayspecsSyncService,
    DisplaySpecsIndexPageService,
    DisplayspecsDetailsPageExtractor,
    DisplayspecsListPageExtractor,
    DisplayspecsCategoryMapperService,
  ],
  exports: [
    DisplayspecsSyncService,
    DisplayspecsDetailsPageExtractor,
    DisplayspecsListPageExtractor,
  ],
})
export class DisplayspecsModule {}
