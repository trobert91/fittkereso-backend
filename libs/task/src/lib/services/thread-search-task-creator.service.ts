import { Injectable } from "@nestjs/common";
import {
  ThreadPlatform,
  ThreadSearchTask,
  ThreadSearchTaskRepository,
  TaskStatus,
} from "@ebike-backend/database";

export interface CreateThreadSearchTaskParams {
  keyword: string;
  platform: ThreadPlatform;
  categorySlug: string;
}

@Injectable()
export class ThreadSearchTaskCreatorService {
  constructor(private readonly repo: ThreadSearchTaskRepository) {}

  async create(
    params: CreateThreadSearchTaskParams,
  ): Promise<ThreadSearchTask> {
    const task = new ThreadSearchTask();
    task.keyword = params.keyword;
    task.platform = params.platform;
    task.categorySlug = params.categorySlug;
    task.status = TaskStatus.PENDING;
    return this.repo.save(task);
  }
}
