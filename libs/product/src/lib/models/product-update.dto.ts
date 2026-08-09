import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsArray,
} from "class-validator";
import { ProductSpecs } from "@ebike-backend/database";
import { Transform } from "class-transformer";

export class ProductModelUpdateDto {
  @IsOptional()
  @IsString()
  productCategoryId?: string;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsObject()
  manualSpecs?: ProductSpecs;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  aliases?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Transform(({ value }) => (value === "" ? undefined : value))
  releaseYear?: number;

  @IsOptional()
  @IsString()
  mainImageId?: string;
}
