import { ScrapeQueueName, TaskStatus } from '@fittkereso-backend/database';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ScrapeTaskSearchParams {
  @IsOptional()
  @IsEnum(TaskStatus, { each: true })
  statuses?: TaskStatus[];

  @IsOptional()
  @IsEnum(ScrapeQueueName, { each: true })
  queues?: ScrapeQueueName[];

  @IsOptional()
  @IsString({ each: true })
  sourceIds?: string[];

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
