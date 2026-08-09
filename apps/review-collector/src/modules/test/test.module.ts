import { Module } from "@nestjs/common";
import { RedditTestController } from "./controllers/reddit-test/reddit-test.controller";
import { ProductTestController } from "./controllers/product-test/product-test.controller";
import { QueueTestController } from "./controllers/queue-test/queue-test.controller";
import { ThreadSearchTestController } from "./controllers/thread-search-test/thread-search-test.controller";
import { RelevanceTestController } from "./controllers/relevance-test/relevance-test.controller";
import { ScheduleTestController } from "./controllers/schedule-test/schedule-test.controller";
import { DatabaseModule } from "@ebike-backend/database";
import { DataforseoModule } from "@ebike-backend/dataforseo";
import { TaskModule } from "@ebike-backend/task";
import { RedditModule } from "@ebike-backend/reddit";
import { RelevanceModule } from "@ebike-backend/relevance";
import { ThreadProcessorModule } from "../thread-processor/thread-processor.module";
import { ThreadSearchModule } from "@ebike-backend/thread-search";
import { SchedulingModule } from "../scheduling/scheduling.module";

@Module({
  imports: [
    DatabaseModule,
    DataforseoModule,
    RelevanceModule,
    TaskModule,
    RedditModule,
    ThreadProcessorModule,
    ThreadSearchModule,
    SchedulingModule,
  ],
  controllers: [
    RedditTestController,
    ProductTestController,
    QueueTestController,
    ThreadSearchTestController,
    RelevanceTestController,
    ScheduleTestController,
  ],
})
export class TestModule {}
