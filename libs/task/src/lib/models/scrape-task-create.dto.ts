import {
  IsDefined,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsDateString,
} from 'class-validator';
import { ScrapeQueueName } from '@fittkereso-backend/database';

export class ScrapeTaskCreateDto {
  @IsDefined()
  @IsEnum(ScrapeQueueName)
  queue: ScrapeQueueName;

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
