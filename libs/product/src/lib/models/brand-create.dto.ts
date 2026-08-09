import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class BrandCreateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  domains?: string[];
}
