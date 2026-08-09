import { Module } from "@nestjs/common";
import { QueuePublisherService } from "./services/queue-publisher.service";
import { DatabaseModule } from "@ebike-backend/database";
import {
  ScrapeTaskPublisherService,
  ScrapeTaskCreatorService,
  ThreadSearchTaskCreatorService,
} from "./services";

@Module({
  imports: [DatabaseModule],
  providers: [
    QueuePublisherService,
    ScrapeTaskPublisherService,
    ScrapeTaskCreatorService,
    ThreadSearchTaskCreatorService,
  ],
  exports: [
    QueuePublisherService,
    ScrapeTaskPublisherService,
    ScrapeTaskCreatorService,
    ThreadSearchTaskCreatorService,
  ],
})
export class TaskModule {}
