import { Column, Entity, Index, Unique } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { nameOf } from '@fittkereso-backend/utils';

export const PRODUCT_SEARCH_CACHE_NO_BRAND = '';
export const PRODUCT_SEARCH_CACHE_NO_CATEGORY =
  '00000000-0000-0000-0000-000000000000';

@Entity()
@Unique([
  nameOf<ProductSearchCache>('normalizedModel'),
  nameOf<ProductSearchCache>('brandName'),
  nameOf<ProductSearchCache>('categoryId'),
  nameOf<ProductSearchCache>('resolutionMode'),
])
export class ProductSearchCache extends BasePostgresEntity {
  // ─── Cache Key Fields ───────────────────────────────────────────────────────

  @Index()
  @Column()
  normalizedModel: string;

  /** Sentinel: '' when no brand */
  @Index()
  @Column({ default: PRODUCT_SEARCH_CACHE_NO_BRAND })
  brandName: string;

  /** Sentinel: PRODUCT_SEARCH_CACHE_NO_CATEGORY when no category */
  @Index()
  @Column({ default: PRODUCT_SEARCH_CACHE_NO_CATEGORY })
  categoryId: string;

  @Index()
  @Column()
  resolutionMode: string;

  // ─── Metadata ───────────────────────────────────────────────────────────────

  @Column({ nullable: true })
  normalizedDisplayName?: string;

  /** Null for negative cache entries (unresolved). ON DELETE SET NULL handled by cleanup TTL. */
  @Column({ type: 'uuid', nullable: true })
  resolvedProductId?: string;

  /** Anchor date for date-window lookup. Only moves forward via GREATEST in upsert. */
  @Index()
  @Column({ type: 'date' })
  mentionDate: Date;

  /** Positive entries: 90 days. Negative entries: 1 day. */
  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'int', default: 0 })
  hitCount: number;

  @Column({ type: 'timestamptz' })
  lastAccessedAt: Date;

  /** Set when a worker begins processing this key; cleared on completion.
   *  Enables distributed deduplication: other workers wait if this is recent. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  processingStartedAt?: Date;
}
