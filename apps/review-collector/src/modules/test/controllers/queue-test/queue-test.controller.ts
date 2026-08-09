import { Body, Controller, Post } from "@nestjs/common";
import { QueuePublisherService, ThreadMessage } from "@ebike-backend/task";

@Controller("queue-test")
export class QueueTestController {
  constructor(private readonly queuePublisher: QueuePublisherService) {}

  @Post("extract-thread")
  async extractThread(@Body() message: ThreadMessage) {
    await this.queuePublisher.addThreadProcessTask(message);

    return { status: "queued" };
  }
}
