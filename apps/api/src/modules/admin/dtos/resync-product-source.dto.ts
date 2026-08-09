import { IsUUID } from 'class-validator';

export class ResyncProductSourceDto {
  @IsUUID()
  productModelSourceId: string;
}
