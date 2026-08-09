import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';

export class TriggerProductSourceFullSyncDto {
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  brandNames?: string[];
}

export class QueueStatusDto {
  status: string;
}
