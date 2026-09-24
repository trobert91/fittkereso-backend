import { IsBoolean, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
  MAX_IMPORT_TASK_PRIORITY,
  MIN_IMPORT_TASK_PRIORITY,
} from '@fittkereso-backend/database';

export class ResyncProductSourceDto {
  @IsUUID()
  sourceRecordId: string;

  @IsOptional()
  @IsBoolean()
  force?: boolean;

  /** 0–100, higher runs first. Default: MANUAL_IMPORT_TASK_PRIORITY (90). */
  @IsOptional()
  @IsInt()
  @Min(MIN_IMPORT_TASK_PRIORITY)
  @Max(MAX_IMPORT_TASK_PRIORITY)
  priority?: number;
}
