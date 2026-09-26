import {
  PRODUCT_SOURCE_RECORD_SORTS,
  type ProductSourceRecordSort,
} from '@fittkereso-backend/database';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Every source's listings, filtered and paged. See ProductSourceRecordFilter. */
export class ProductSourceRecordSearchParams {
  @IsOptional()
  @IsUUID('all', { each: true })
  sourceIds?: string[];

  /** True: on a product. False: unattached. Omitted: both. */
  @IsOptional()
  @IsBoolean()
  attached?: boolean;

  /** True: specs valid. False: failed spec validation. Omitted: both. */
  @IsOptional()
  @IsBoolean()
  valid?: boolean;

  /** The listing's URL, externalIds or title. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /** The name of the product the listing sits on. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  productName?: string;

  /** The brand the listing states. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string;

  /** The category the listing was imported into. */
  @IsOptional()
  @IsUUID('all', { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;

  @IsOptional()
  @IsIn(PRODUCT_SOURCE_RECORD_SORTS)
  sort?: ProductSourceRecordSort;

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC';
}
