import { QueueName, TaskStatus } from '@fittkereso-backend/database';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';

export class TaskSearchParams {
  @IsOptional()
  @IsEnum(TaskStatus, { each: true })
  statuses?: TaskStatus[];

  @IsOptional()
  @IsEnum(QueueName, { each: true })
  queues?: QueueName[];

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsEnum([
    'queue',
    'status',
    'attempts',
    'scheduledAt',
    'lastRunAt',
    'lockedAt',
    'executionTimeInSec',
    'createdAt',
    'updatedAt',
  ])
  sort?:
    | 'queue'
    | 'status'
    | 'attempts'
    | 'scheduledAt'
    | 'lastRunAt'
    | 'lockedAt'
    | 'executionTimeInSec'
    | 'createdAt'
    | 'updatedAt';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC';
}
