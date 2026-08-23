import { IsOptional, IsString, IsNumber, IsEnum, Min } from 'class-validator';
import { Type } from 'class-transformer';
import {
  ProductDuplicateDecision,
  ProductDuplicateOrigin,
} from '@fittkereso-backend/database';

export class ProductDuplicateSearchParams {
  @IsOptional()
  @IsEnum(ProductDuplicateDecision)
  decision?: ProductDuplicateDecision;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsEnum(ProductDuplicateOrigin)
  origin?: ProductDuplicateOrigin;

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
}
