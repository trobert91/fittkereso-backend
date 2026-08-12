import { Module } from '@nestjs/common';
import { TaskModule } from '@fittkereso-backend/task';
import { ProductSourceSyncListener } from './task/product-source-sync-listener.service';
import { TaskManagerService } from './task/task-manager.service';
import { DatabaseModule } from '@fittkereso-backend/database';
import { DisplayspecsQueueProcessorService } from './scrape-task/displayspecs-queue-processor.service';
import { ScrapeTaskManagerService } from './scrape-task/scrape-task-manager.service';
import {
  ArukeresoModule,
  DisplayspecsModule,
  IncrementalSyncModule,
  ProductScraperModule,
} from '@fittkereso-backend/product-scraper';
import { ArukeresoQueueProcessorService } from './scrape-task/arukereso-queue-processor.service';
import { ScrapeTaskQueueDepthService } from './scrape-task/scrape-task-queue-depth.service';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';

@Module({
  imports: [
    DatabaseModule,
    ArukeresoModule,
    DisplayspecsModule,
    IncrementalSyncModule,
    DynamicConfigModule,
    ProductScraperModule,
    TaskModule,
    MetricsModule,
  ],
  providers: [
    ProductSourceSyncListener,
    TaskManagerService,
    ArukeresoQueueProcessorService,
    DisplayspecsQueueProcessorService,
    ScrapeTaskManagerService,
    ScrapeTaskQueueDepthService,
  ],
})
export class QueueProcessorModule {}
