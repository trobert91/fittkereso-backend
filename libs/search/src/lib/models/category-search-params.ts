import {
  IsOptional,
  IsString,
  IsInt,
  IsBoolean,
  Min,
  IsIn,
} from 'class-validator';

export class CategorySearchParams {
  @IsOptional()
  @IsString()
  searchTerm?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsIn(['name', 'createdAt', 'updatedAt', 'enabled'])
  sort?: 'name' | 'createdAt' | 'updatedAt' | 'enabled';

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC';

  @IsOptional()
  @IsBoolean()
  includeConfig?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
