import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsArray,
} from 'class-validator';
import { ProductSpecs } from '@fittkereso-backend/database';

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
  @IsString()
  mainImageId?: string;
}
