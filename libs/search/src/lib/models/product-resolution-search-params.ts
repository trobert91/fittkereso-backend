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
  ResolutionAiConfidence,
  ResolutionDecidedBy,
  ResolutionReviewTrigger,
} from '@fittkereso-backend/database';

export const RESOLUTION_SORT_FIELDS = [
  'priority',
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

  /** Work a band of the queue. No default — the queue shows everything, sorted;
   *  nothing disappears from it silently. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Type(() => Number)
  minPriority?: number;

  /**
   * Any-of over `reviewTriggers` — show rows matching **at least one** of these.
   *
   * Any-of rather than all-of because the triggers are independent suspicions,
   * not facets: "show me everything with a spec conflict or a narrow margin" is
   * the question a reviewer asks, while the intersection of two suspicions is
   * usually empty and never interesting.
   */
  @IsOptional()
  @IsEnum(ResolutionReviewTrigger, { each: true })
  triggers?: ResolutionReviewTrigger[];

  /**
   * `true` — the row has no trigger at all (`reviewTriggers = '[]'`).
   * `false` — at least one fired.
   *
   * Separate from `triggers` because the empty list cannot be expressed as an
   * any-of over names, and it is the single most important set to be able to
   * look at: it is exactly what deterministic auto-accept will trust, so being
   * able to read a page of it *before* enabling Phase 3 is the whole point of
   * this filter.
   */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  untriggered?: boolean;

  /** How sure the AI was. `low`/`medium` is the "things the machine couldn't
   *  settle" queue — the rows most worth a human's time. */
  @IsOptional()
  @IsEnum(ResolutionAiConfidence, { each: true })
  aiConfidence?: ResolutionAiConfidence[];

  /** `true` — the AI has judged this row; `false` — it has not yet. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  aiReviewed?: boolean;

  /** Who settled the row. `system`/`ai` on a `done` row is the automation audit
   *  stream — "what did the machine close last night". */
  @IsOptional()
  @IsEnum(ResolutionDecidedBy, { each: true })
  decidedBy?: ResolutionDecidedBy[];

  /** Free-text over the involved products' display names and the anchor key. */
  @IsOptional()
  @IsString()
  query?: string;

  /** `priority` (default) — how important it is that a human looks at the row.
   *  Every option is a real column; there is no computed order any more. */
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
