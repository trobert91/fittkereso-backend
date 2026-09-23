import { Module } from '@nestjs/common';
import { ProductSourceSyncScheduler } from './product-source-sync-scheduler.service';
import { ProductDuplicateScanScheduler } from './product-duplicate-scan-scheduler.service';
import { StaleOfferSweepScheduler } from './stale-offer-sweep-scheduler.service';
import { DatabaseModule } from '@fittkereso-backend/database';
import { TaskModule } from '@fittkereso-backend/task';
import { MetricsModule } from '@fittkereso-backend/metrics';
import { ProductModule } from '@fittkereso-backend/product';
import { ProductIdentityModule } from '@fittkereso-backend/product-identity';
import { SearchModule } from '@fittkereso-backend/search';
import { DynamicConfigModule } from '@fittkereso-backend/dynamic-config';

@Module({
  imports: [
    DatabaseModule,
    DynamicConfigModule,
    MetricsModule,
    ProductModule,
    ProductIdentityModule,
    SearchModule,
    TaskModule,
  ],
  providers: [
    ProductSourceSyncScheduler,
    ProductDuplicateScanScheduler,
    StaleOfferSweepScheduler,
  ],
})
export class SchedulingModule {}
