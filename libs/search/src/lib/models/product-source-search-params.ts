import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class ProductSourceSearchParams {
  @IsOptional()
  @IsString()
  searchTerm?: string;

  @IsOptional()
  @IsString()
  sellerId?: string;

  @IsOptional()
  @IsBoolean()
  schedulingEnabled?: boolean;

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
    'name',
    'schedulingEnabled',
    'processingEnabled',
    'priority',
    'maxConcurrent',
    'requestsPerHour',
    'lastRunAt',
    'fullSyncInterval',
    'nextFullSyncAt',
    'lastFullSyncAt',
    'incrementalSyncInterval',
    'nextIncrementalSyncAt',
    'lastIncrementalSyncAt',
    'createdAt',
    'updatedAt',
  ])
  sort?:
    | 'name'
    | 'schedulingEnabled'
    | 'processingEnabled'
    | 'priority'
    | 'maxConcurrent'
    | 'requestsPerHour'
    | 'lastRunAt'
    | 'fullSyncInterval'
    | 'nextFullSyncAt'
    | 'lastFullSyncAt'
    | 'incrementalSyncInterval'
    | 'nextIncrementalSyncAt'
    | 'lastIncrementalSyncAt'
    | 'createdAt'
    | 'updatedAt';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC';
}
