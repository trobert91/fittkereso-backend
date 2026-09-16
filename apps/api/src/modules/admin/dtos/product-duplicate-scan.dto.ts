import { IsOptional, IsUUID } from 'class-validator';

export class ProductDuplicateScanDto {
  /** One product to re-detect now. Omit to start a scan of the whole catalog. */
  @IsOptional()
  @IsUUID()
  productId?: string;
}
