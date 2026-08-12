import { Body, Controller, Post } from '@nestjs/common';
import {
  ProductSourceSyncMessage,
  QueuePublisherService,
} from '@fittkereso-backend/task';

@Controller('product-source-test')
export class ProductSourceTestController {
  constructor(private readonly queuePublisher: QueuePublisherService) {}

  @Post('sync')
  async startSync(@Body() message: ProductSourceSyncMessage) {
    await this.queuePublisher.addProductSourceSyncTask(message);

    return { status: 'queued' };
  }
}
