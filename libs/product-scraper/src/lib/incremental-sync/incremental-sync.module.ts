import { Module } from "@nestjs/common";
import { DatabaseModule } from "@ebike-backend/database";
import { ExaModule } from "@ebike-backend/exa";
import { MetricsModule } from "@ebike-backend/metrics";
import { TaskModule } from "@ebike-backend/task";
import { IncrementalSyncService } from "./incremental-sync.service";
import { ArukeresoUrlClassifier } from "./classifiers/arukereso-url-classifier";
import { DisplayspecsUrlClassifier } from "./classifiers/displayspecs-url-classifier";
import { ProductScraperModule } from "../product-scraper";

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
