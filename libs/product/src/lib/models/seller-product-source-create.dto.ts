import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
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

  /**
   * Unique per seller. Omitted, a seller's first source gets 10 and a later
   * one lands below the seller's lowest (ProductSourceSellerRulesService).
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  /** Defaults to true. A seller's first source must identify products. */
  @IsOptional()
  @IsBoolean()
  identifiesProducts?: boolean;

  /** Defaults to false. Feed sources only. */
  @IsOptional()
  @IsBoolean()
  hasAllProducts?: boolean;
}
