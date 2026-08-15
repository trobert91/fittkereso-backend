import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { SellerType } from '@fittkereso-backend/database';

const emptyStringToUndefined = ({ value }: { value: unknown }) =>
  value === '' ? undefined : value;

export class SellerUpdateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEnum(SellerType)
  type: SellerType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  domains?: string[];

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsBoolean()
  verified?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
