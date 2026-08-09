import { Injectable } from "@nestjs/common";
import {
  TaskStatus,
  ScrapeTask,
  ScrapeTaskRepository,
} from "@ebike-backend/database";

@Injectable()
export class ScrapeTaskPublisherService {
  constructor(private readonly taskRepo: ScrapeTaskRepository) {}

  public async addTask(task: ScrapeTask) {
    task.status = TaskStatus.PENDING;

    await this.taskRepo.save(task);
  }

  public async addTasks(tasks: ScrapeTask[]) {
    tasks.forEach((task) => (task.status = TaskStatus.PENDING));

    await this.taskRepo.saveAll(tasks);
  }
}
