import { Module } from "@nestjs/common";
import { ArukeresoSyncService } from "./services/arukereso-sync.service";
import { ArukeresoIndexPageService } from "./services/arukereso-index-page.service";
import { ArukeresoDetailsPageExtractor } from "./services/details/arukereso-details-page-extractor.service";
import { ArukeresoCategoryMapperService } from "./services/details/arukereso-category-mapper.service";
import { ArukeresoListPageExtractor } from "./services/list/arukereso-list-page-extractor.service";
import { TaskModule } from "@ebike-backend/task";
import { ScraperModule } from "@ebike-backend/scraper";
import { DatabaseModule } from "@ebike-backend/database";
import { MetricsModule } from "@ebike-backend/metrics";
import { TranslationModule } from "@ebike-backend/translation";
import { ProductScraperModule } from "../product-scraper";
import { ProductModule } from "@ebike-backend/product";

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
