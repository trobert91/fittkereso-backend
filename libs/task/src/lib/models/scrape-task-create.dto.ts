import {
  IsDefined,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsDateString,
} from "class-validator";
import { ScrapeQueueName } from "@ebike-backend/database";

export class ScrapeTaskCreateDto {
  @IsDefined()
  @IsEnum(ScrapeQueueName)
  queue: ScrapeQueueName;

  @IsDefined()
  @IsUUID()
  sourceId: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsDefined()
  @IsString()
  url: string;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
