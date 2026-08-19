import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class ResyncProductSourceDto {
  @IsUUID()
  sourceRecordId: string;

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
