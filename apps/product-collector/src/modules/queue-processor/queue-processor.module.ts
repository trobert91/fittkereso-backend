import { Module } from '@nestjs/common';
import { TaskModule } from '@fittkereso-backend/task';
import { ProductSourceSyncListener } from './task/product-source-sync-listener.service';
import { TaskManagerService } from './task/task-manager.service';
import { DatabaseModule } from '@fittkereso-backend/database';
import { ProductImportTaskManagerService } from './product-import-task/product-import-task-manager.service';
import { ProductImportTaskProcessorService } from './product-import-task/product-import-task-processor.service';
import { ProductScraperModule } from '@fittkereso-backend/product-scraper';
import { ProductImportTaskQueueDepthService } from './product-import-task/product-import-task-queue-depth.service';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';
import { ProductModule } from '@fittkereso-backend/product';

@Module({
  imports: [
    DatabaseModule,
    DynamicConfigModule,
    ProductScraperModule,
    TaskModule,
    MetricsModule,
    // For ProductSourceVersionService, which the two config guards use to
    // record a validation failure on the source's own timeline.
    ProductModule,
  ],
  providers: [
    ProductSourceSyncListener,
    TaskManagerService,
    ProductImportTaskProcessorService,
    ProductImportTaskManagerService,
    ProductImportTaskQueueDepthService,
  ],
})
export class QueueProcessorModule {}
