import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import {
  PRODUCT_SOURCE_TYPES,
  ProductSourceType,
} from '@fittkereso-backend/database';

export class SellerProductSourceCreateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  /**
   * Create-only. The config format is type-bound, so this cannot be changed
   * afterwards — ProductSourceUpdateService rejects any attempt to.
   */
  @IsIn(PRODUCT_SOURCE_TYPES as readonly string[])
  type: ProductSourceType;
}
