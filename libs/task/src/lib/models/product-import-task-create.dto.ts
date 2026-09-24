import {
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsDateString,
  Max,
  Min,
} from 'class-validator';
import {
  MAX_IMPORT_TASK_PRIORITY,
  MIN_IMPORT_TASK_PRIORITY,
  ProductImportTaskKind,
} from '@fittkereso-backend/database';

export class ProductImportTaskCreateDto {
  @IsDefined()
  @IsEnum(ProductImportTaskKind)
  kind: ProductImportTaskKind;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsDefined()
  @IsString()
  url: string;

  /**
   * Which source this task belongs to.
   *
   * Optional, but the only reliable answer once a webshop has several sources:
   * without it the source is resolved from the URL's domain, which is refused
   * rather than guessed when more than one scraping source shares it.
   */
  @IsOptional()
  @IsUUID()
  productSourceId?: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  /** 0–100, higher runs first. A person's task defaults to MANUAL_IMPORT_TASK_PRIORITY (90). */
  @IsOptional()
  @IsInt()
  @Min(MIN_IMPORT_TASK_PRIORITY)
  @Max(MAX_IMPORT_TASK_PRIORITY)
  priority?: number;
}
