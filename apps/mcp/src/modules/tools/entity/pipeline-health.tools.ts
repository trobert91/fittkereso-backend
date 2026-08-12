import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { Task, TaskRepository } from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';

@Injectable()
export class PipelineHealthTools {
  constructor(private readonly taskRepo: TaskRepository) {}

  @Tool({
    name: 'get_pipeline_health',
    description:
      'Get pipeline health overview — task queue status by queue and state. Use to diagnose processing issues.',
    parameters: z.object({}),
    annotations: { readOnlyHint: true },
  })
  async getPipelineHealth(): Promise<string> {
    // Task queue status
    const taskQueueColumn = `t.${nameOf<Task>('queue')}`;
    const taskStatusColumn = `t.${nameOf<Task>('status')}`;
    const taskStats: { queue: string; status: string; count: string }[] =
      await this.taskRepo.repo
        .createQueryBuilder('t')
        .select(taskQueueColumn, 'queue')
        .addSelect(taskStatusColumn, 'status')
        .addSelect('COUNT(*)::int', 'count')
        .groupBy(taskQueueColumn)
        .addGroupBy(taskStatusColumn)
        .orderBy(taskQueueColumn, 'ASC')
        .addOrderBy('count', 'DESC')
        .getRawMany();

    const L: string[] = [];
    L.push('# Pipeline Health');
    L.push('');

    // Task queue status
    if (taskStats.length > 0) {
      // Pivot: group by queue, show status counts
      const queues = new Map<string, Map<string, number>>();
      for (const row of taskStats) {
        if (!queues.has(row.queue)) queues.set(row.queue, new Map());
        queues.get(row.queue)!.set(row.status, Number(row.count));
      }

      L.push('## Task Queue Status');
      L.push('| Queue | Pending | Processing | Done | Failed |');
      L.push('|-------|---------|------------|------|--------|');
      for (const [queue, statuses] of queues) {
        L.push(
          `| ${queue} | ${statuses.get('pending') ?? 0} | ${statuses.get('processing') ?? 0} | ${statuses.get('done') ?? 0} | ${statuses.get('failed') ?? 0} |`,
        );
      }
      L.push('');
    } else {
      L.push('_No tasks in queue._');
      L.push('');
    }

    return L.join('\n');
  }
}
