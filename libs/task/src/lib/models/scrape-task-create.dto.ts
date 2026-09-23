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
}
