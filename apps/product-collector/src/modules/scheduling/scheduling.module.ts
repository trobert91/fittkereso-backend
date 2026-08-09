import { Module } from "@nestjs/common";
import { ProductSourceSyncScheduler } from "./product-source-sync-scheduler.service";
import { DuplicateDetectionScheduler } from "./duplicate-detection-scheduler.service";
import { DatabaseModule } from "@ebike-backend/database";
import { TaskModule } from "@ebike-backend/task";
import { MetricsModule } from "@ebike-backend/metrics";
import { ProductModule } from "@ebike-backend/product";
import { SearchModule } from "@ebike-backend/search";
import { DynamicConfigModule } from "@ebike-backend/dynamic-config";

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
