import { IsUUID } from 'class-validator';

export class ProductMergeDto {
  @IsUUID()
  targetProductId: string;
}
