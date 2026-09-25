import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
} from 'class-validator';
import { ProductSourceConfig } from '@fittkereso-backend/database';

export class UpdateProductSourceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  // Reassigns the source to a different storefront seller. Every Offer this
  // source produces derives its seller from here, so moving a source moves
  // the seller shown on all of its future offers.
  @IsOptional()
  @IsUUID()
  sellerId?: string;

  @IsOptional()
  @IsObject()
  config?: ProductSourceConfig;

  @IsOptional()
  @IsBoolean()
  schedulingEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  processingEnabled?: boolean;

  // Unique per seller; the update service refuses a taken value.
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  // Off, the source only contributes to the seller's existing offers. A seller
  // keeps at least one identifying source.
  @IsOptional()
  @IsBoolean()
  identifiesProducts?: boolean;

  // Feed sources only: a complete run may remove the offers it did not see.
  @IsOptional()
  @IsBoolean()
  hasAllProducts?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxConcurrent?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  requestsPerHour?: number;

  @IsOptional()
  @IsString()
  frequency?: string | null;

  // Scheduler inputs, not audit fields: ProductSourceSyncScheduler treats a
  // null/past value as "due now", so clearing it forces the next cron tick to
  // queue a sync. The last*/lastRunAt timestamps stay read-only.
  @IsOptional()
  @IsDateString()
  nextRunAt?: string | null;
}
