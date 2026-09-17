import { DuplicateDetectedBy } from '@fittkereso-backend/database';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class ProductDuplicatePairSearchParams {
  /** Open pairs are waiting for a decision, dismissed ones were called "not duplicates". Both when unset. */
  @IsOptional()
  @IsIn(['open', 'dismissed'])
  status?: 'open' | 'dismissed';

  /** Category, brand and product filters match either side of the pair. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  brandIds?: string[];

  @IsOptional()
  @IsString()
  productId?: string;

  /** Both bounds are inclusive; either alone is a one-sided range. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  minScore?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  maxScore?: number;

  @IsOptional()
  @IsArray()
  @IsIn(['scrape', 'scan', 'merge'], { each: true })
  detectedBy?: DuplicateDetectedBy[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  pageSize?: number;

  @IsOptional()
  @IsIn(['similarityScore', 'createdAt'])
  sort?: 'similarityScore' | 'createdAt';

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC';
}
