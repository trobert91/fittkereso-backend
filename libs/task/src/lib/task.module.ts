import { Module } from '@nestjs/common';
import { QueuePublisherService } from './services/queue-publisher.service';
import { DatabaseModule } from '@fittkereso-backend/database';
import {
  ScrapeTaskPublisherService,
  ScrapeTaskCreatorService,
} from './services';

@Module({
  imports: [DatabaseModule],
  providers: [
    QueuePublisherService,
    ScrapeTaskPublisherService,
    ScrapeTaskCreatorService,
  ],
  exports: [
    QueuePublisherService,
    ScrapeTaskPublisherService,
    ScrapeTaskCreatorService,
  ],
})
export class TaskModule {}
