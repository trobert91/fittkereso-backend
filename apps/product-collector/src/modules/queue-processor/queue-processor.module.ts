import { Module } from '@nestjs/common';
import { TaskModule } from '@fittkereso-backend/task';
import { ProductSourceSyncListener } from './task/product-source-sync-listener.service';
import { TaskManagerService } from './task/task-manager.service';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ScrapeTaskManagerService } from './scrape-task/scrape-task-manager.service';
import { ScrapeTaskProcessorService } from './scrape-task/scrape-task-processor.service';
import {
  IncrementalSyncModule,
  ProductScraperModule,
} from '@fittkereso-backend/product-scraper';
import { ScrapeTaskQueueDepthService } from './scrape-task/scrape-task-queue-depth.service';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';

@Module({
  imports: [
    DatabaseModule,
    IncrementalSyncModule,
    DynamicConfigModule,
    ProductScraperModule,
    TaskModule,
    MetricsModule,
  ],
  providers: [
    ProductSourceSyncListener,
    TaskManagerService,
    ScrapeTaskProcessorService,
    ScrapeTaskManagerService,
    ScrapeTaskQueueDepthService,
  ],
})
export class QueueProcessorModule {}
