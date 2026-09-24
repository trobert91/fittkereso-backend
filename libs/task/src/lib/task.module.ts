import { Module } from '@nestjs/common';
import { QueuePublisherService } from './services/queue-publisher.service';
import { DatabaseModule } from '@fittkereso-backend/database';
import {
  ProductImportTaskPublisherService,
  ProductImportTaskCreatorService,
} from './services';

@Module({
  imports: [DatabaseModule],
  providers: [
    QueuePublisherService,
    ProductImportTaskPublisherService,
    ProductImportTaskCreatorService,
  ],
  exports: [
    QueuePublisherService,
    ProductImportTaskPublisherService,
    ProductImportTaskCreatorService,
  ],
})
export class TaskModule {}
