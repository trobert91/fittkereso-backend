import {
  IsOptional,
  IsArray,
  IsString,
  IsNumber,
  Min,
  IsIn,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProductSearchParams {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  brandIds?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  minPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  maxPrice?: number;

  @IsOptional()
  @IsString()
  searchTerm?: string;

  /**
   * Exact product id. Separate from `searchTerm` rather than folded into it: a
   * uuid is something you have (from a log line, a decision entry, another
   * screen) and want to look up exactly, and putting it through the trigram
   * ranker would return near-miss ids alongside the one asked for.
   *
   * A malformed uuid must not 500 the search — Postgres rejects the comparison
   * before any row is read — so the value is validated here and the service
   * treats an unparseable one as "no product has this id".
   */
  @IsOptional()
  @IsString()
  id?: string;

  /**
   * A barcode: the products with an offer carrying it, from any shop, stale
   * or not. Normalized the way an imported one is (normalizeGtin), so an EAN-13
   * and its zero-padded GTIN-14 find the same product. A value that is not a
   * valid GTIN finds nothing.
   */
  @IsOptional()
  @IsString()
  gtin?: string;

  /**
   * The start of a manufacturer article number: the products with an offer
   * whose MPN begins with it. Normalized the way an imported one is
   * (normalizeMpn: case, spaces and hyphens dropped), so under 5 characters
   * it finds nothing.
   */
  @IsOptional()
  @IsString()
  mpn?: string;

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

  @IsOptional()
  @IsIn(['model', 'displayName', 'createdAt', 'updatedAt'])
  sort?: 'model' | 'displayName' | 'createdAt' | 'updatedAt';

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC';

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  includeImages?: boolean;

  /**
   * Spec filters, keyed by canonical spec field name (e.g. "frameSize",
   * "wheelSize"). Value is either an exact match (string/number) or a
   * [min, max] range. Keys flagged as offer-level in the relevant
   * category's ProductCategoryConfig.offerLevelSpecs are matched against
   * Offer.specs (any current offer on the product may satisfy the filter);
   * all other keys are matched against ProductModel.specs directly.
   */
  @IsOptional()
  specFilters?: Record<string, string | number | [number, number]>;
}
