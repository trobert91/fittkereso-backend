import {
  IsOptional,
  IsString,
  IsNumber,
  IsEnum,
  IsBoolean,
  IsIn,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  ProductResolutionFlow,
  ProductResolutionOrigin,
  ProductResolutionStatus,
} from '@fittkereso-backend/database';

export const RESOLUTION_SORT_FIELDS = [
  'relevance',
  'similarityScore',
  'decisionConfidence',
  'createdAt',
  'lastSeenAt',
] as const;

export type ProductResolutionSortField =
  (typeof RESOLUTION_SORT_FIELDS)[number];

export class ProductResolutionSearchParams {
  /** Filter to one flow ('product_resolution' | 'duplicate_detection').
   *  Omit to show decisions from both flows in one page. */
  @IsOptional()
  @IsEnum(ProductResolutionFlow)
  flow?: ProductResolutionFlow;

  /** Filter to a single workflow state. Combined with `statuses` if both given.
   *  When neither is set the search returns only rows that still need
   *  attention — the queue shows work, not history. */
  @IsOptional()
  @IsEnum(ProductResolutionStatus)
  status?: ProductResolutionStatus;

  @IsOptional()
  @IsEnum(ProductResolutionStatus, { each: true })
  statuses?: ProductResolutionStatus[];

  /** The human verdict: true = confirmed, false = not (yet) confirmed. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => (value === undefined ? undefined : value === true || value === 'true'))
  accepted?: boolean;

  @IsOptional()
  @IsString()
  categoryId?: string;

  /** The `ProductSource` the reviewed listing was scraped from. */
  @IsOptional()
  @IsString()
  sourceId?: string;

  /** Any row touching this product — as a duplicate pair member, the resolved
   *  product, or the product the reviewed listing currently sits on. */
  @IsOptional()
  @IsString()
  productId?: string;

  /** Only meaningful when `flow = duplicate_detection`. */
  @IsOptional()
  @IsEnum(ProductResolutionOrigin)
  origin?: ProductResolutionOrigin;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  minSimilarityScore?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  minConfidence?: number;

  /** Free-text over the involved products' display names and the anchor key. */
  @IsOptional()
  @IsString()
  query?: string;

  /** `relevance` (default) means pending first, then closest calls — the order
   *  to review in. Any other field sorts by that column directly. */
  @IsOptional()
  @IsIn(RESOLUTION_SORT_FIELDS as unknown as string[])
  sortBy?: ProductResolutionSortField;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortDir?: 'ASC' | 'DESC';

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  pageSize?: number;
}
