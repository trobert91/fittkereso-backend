import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export enum SortBy {
  releaseYear = 'releaseYear',
}

export class ProductQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 40;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsEnum(SortBy)
  sortBy?: SortBy = SortBy.releaseYear;

  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortDir?: 'asc' | 'desc' = 'desc';

  /** Spec filters: specs[key]=value or specs[key][min]=N&specs[key][max]=N */
  @IsOptional()
  @IsObject()
  specs?: Record<string, string | { min?: string; max?: string }>;
}
