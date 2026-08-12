import { Module } from '@nestjs/common';
import { ProductSourceSyncScheduler } from './product-source-sync-scheduler.service';
import { DuplicateDetectionScheduler } from './duplicate-detection-scheduler.service';
import { DatabaseModule } from '@fittkereso-backend/database';
import { TaskModule } from '@fittkereso-backend/task';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { ProductModule } from '@fittkereso-backend/product';
import { SearchModule } from '@fittkereso-backend/search';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';

@Module({
  imports: [
    DatabaseModule,
    DynamicConfigModule,
    MetricsModule,
    ProductModule,
    SearchModule,
    TaskModule,
  ],
  providers: [ProductSourceSyncScheduler, DuplicateDetectionScheduler],
})
export class SchedulingModule {}
