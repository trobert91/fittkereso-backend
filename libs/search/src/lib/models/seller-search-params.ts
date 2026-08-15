import { SellerType } from '@fittkereso-backend/database';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class SellerSearchParams {
  @IsOptional()
  @IsString()
  searchTerm?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(SellerType, { each: true })
  types?: SellerType[];

  @IsOptional()
  @IsBoolean()
  verified?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  pageSize?: number;

  @IsOptional()
  @IsIn(['name', 'type', 'verified', 'active', 'createdAt', 'updatedAt'])
  sort?:
    | 'name'
    | 'type'
    | 'verified'
    | 'active'
    | 'createdAt'
    | 'updatedAt';

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC';
}
