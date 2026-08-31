import { IsOptional, IsString, IsNumber, IsEnum, Min } from 'class-validator';
import { Type } from 'class-transformer';
import {
  ProductResolutionDecision,
  ProductResolutionFlow,
  ProductResolutionOrigin,
} from '@fittkereso-backend/database';

export class ProductResolutionSearchParams {
  /** Filter to one flow ('product_resolution' | 'duplicate_detection').
   *  Omit to show decisions from both flows in one page. */
  @IsOptional()
  @IsEnum(ProductResolutionFlow)
  flow?: ProductResolutionFlow;

  /** Meaningful for both flows — see `ProductResolutionDecision`. */
  @IsOptional()
  @IsEnum(ProductResolutionDecision)
  decision?: ProductResolutionDecision;

  @IsOptional()
  @IsString()
  categoryId?: string;

  /** Only meaningful when `flow = duplicate_detection`. */
  @IsOptional()
  @IsEnum(ProductResolutionOrigin)
  origin?: ProductResolutionOrigin;

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
