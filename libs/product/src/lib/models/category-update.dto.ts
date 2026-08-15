import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import type { SpecDefinitionUiSchema } from '@fittkereso-backend/database';
import { SpecDefinitionJsonSchema } from '@fittkereso-backend/database';

export class CategoryUpdateDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsObject()
  jsonSchema?: SpecDefinitionJsonSchema;

  @IsOptional()
  @IsObject()
  uiSchema?: SpecDefinitionUiSchema;
}
