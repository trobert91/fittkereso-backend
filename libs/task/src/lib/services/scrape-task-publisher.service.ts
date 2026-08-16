import { Injectable } from '@nestjs/common';
import {
  TaskStatus,
  ScrapeTask,
  ScrapeTaskRepository,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';

@Injectable()
export class ScrapeTaskPublisherService {
  private readonly logger = new CustomLogger(ScrapeTaskPublisherService.name);

  constructor(private readonly taskRepo: ScrapeTaskRepository) {}

  public async addTask(task: ScrapeTask) {
    task.status = TaskStatus.PENDING;

    await this.taskRepo.save(task);

    this.logger.debug('Published scrape task', {
      taskId: task.id,
      queue: task.queue,
      url: task.url,
      sourceId: task.source?.id,
    });
  }

  public async addTasks(tasks: ScrapeTask[]) {
    tasks.forEach((task) => (task.status = TaskStatus.PENDING));

    await this.taskRepo.saveAll(tasks);

    this.logger.debug(`Published ${tasks.length} scrape task(s)`, {
      count: tasks.length,
      queues: [...new Set(tasks.map((task) => task.queue))],
      sourceIds: [...new Set(tasks.map((task) => task.source?.id).filter(Boolean))],
    });
  }
}
