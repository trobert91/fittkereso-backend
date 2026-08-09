import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import type { SpecDefinitionUiSchema } from "@ebike-backend/database";
import { SpecDefinitionJsonSchema } from "@ebike-backend/database";

export class CategoryUpdateDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  extractionEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  searchEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  searchPriority?: number;

  @IsOptional()
  @IsBoolean()
  autoDeduplicationEnabled?: boolean;

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
