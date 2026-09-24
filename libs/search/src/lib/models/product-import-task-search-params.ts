import { ProductImportTaskKind, TaskStatus } from '@fittkereso-backend/database';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ProductImportTaskSearchParams {
  @IsOptional()
  @IsEnum(TaskStatus, { each: true })
  statuses?: TaskStatus[];

  @IsOptional()
  @IsEnum(ProductImportTaskKind, { each: true })
  kinds?: ProductImportTaskKind[];

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
    'kind',
    'priority',
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
    | 'kind'
    | 'priority'
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
