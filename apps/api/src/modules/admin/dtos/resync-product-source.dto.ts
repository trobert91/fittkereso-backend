import { IsUUID } from 'class-validator';

export class ResyncProductSourceDto {
  @IsUUID()
  sourceRecordId: string;
}
