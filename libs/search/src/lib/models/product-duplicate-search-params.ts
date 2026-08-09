import { IsOptional, IsString, IsNumber, IsEnum, Min } from "class-validator";
import { Type } from "class-transformer";
import { ProductDuplicateDecision } from "@ebike-backend/database";

export class ProductDuplicateSearchParams {
  @IsOptional()
  @IsEnum(ProductDuplicateDecision)
  decision?: ProductDuplicateDecision;

  @IsOptional()
  @IsString()
  categoryId?: string;

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
