import { IsUUID } from 'class-validator';

export class ProductDuplicateMergeDto {
  /** The pair's product to keep; the other one is folded into it. */
  @IsUUID()
  survivorProductId: string;
}
