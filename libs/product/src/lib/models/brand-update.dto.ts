import { IsArray, IsOptional, IsString } from 'class-validator';

export class BrandUpdateDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  domains?: string[];
}
