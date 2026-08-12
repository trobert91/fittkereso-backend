import { Injectable } from '@nestjs/common';
import {
  ProductReviewAnalysisMessage,
  ProductSourceSyncMessage,
} from '../models/messages';
import {
  TaskRepository,
  Task,
  TaskStatus,
  QueueName,
} from '@fittkereso-backend/database';

@Injectable()
export class QueuePublisherService {
  constructor(private readonly taskRepo: TaskRepository) {}

  async addProductSourceSyncTask(
    message: ProductSourceSyncMessage,
  ): Promise<void> {
    const task = new Task();
    task.queue = QueueName.ProductSourceSync;
    task.payload = message;

    await this.addTask(task);
  }

  async addProductReviewAnalysisTask(
    message: ProductReviewAnalysisMessage,
  ): Promise<void> {
    const task = new Task();
    task.queue = QueueName.ProductReviewAnalysis;
    task.payload = message;
    task.deleteAfterSuccess = true;

    await this.addTask(task);
  }

  private async addTask(task: Task): Promise<void> {
    task.status = TaskStatus.PENDING;

    await this.taskRepo.save(task);
  }
}
