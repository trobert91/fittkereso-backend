import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { ProductModel } from './product-model.entity';
import { ProductResolutionDecision } from '../types/product-resolution-decision';
import { ProductResolutionOrigin } from '../types/product-resolution-origin';
import { ProductResolutionFlow } from '../types/product-resolution-flow';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { Expose, Transform } from 'class-transformer';
import { transfromExposeAll } from '@fittkereso-backend/utils';
import type { SpecMatchDetails } from '../types/spec-match-details';
import type { ProductResolutionCandidateRecord } from '../types/product-resolution-candidate';
import type {
  ProductResolutionInputSnapshot,
  ProductDuplicateDetectionInputSnapshot,
} from '../types/product-resolution-input-snapshot';
import type { ProductResolutionDecisionSnapshot } from '../types/product-resolution-decision-snapshot';

/**
 * Unified record of a product-resolution decision, from either of two flows
 * (`flow`): the real-time identity-resolution pipeline (`product_resolution`,
 * `libs/resolution`) or the duplicate-detection system (`duplicate_detection`,
 * nightly cron + scrape-time safety net). Every row is actionable via
 * `decision`/approve/reject, regardless of flow — see `ProductResolutionDecision`
 * for what approve/reject mean per flow.
 */
@Entity()
@Unique(['productA', 'productB'])
export class ProductResolution extends BasePostgresEntity {
  @Index()
  @Column({ type: 'enum', enum: ProductResolutionFlow })
  @Expose({ groups: [SerializeGroup.adminList] })
  flow: ProductResolutionFlow;

  /** How this pair was discovered — nightly post-hoc cron vs. flagged live
   *  during scraping. Only set when `flow = duplicate_detection`. */
  @Index()
  @Column({
    type: 'enum',
    enum: ProductResolutionOrigin,
    nullable: true,
  })
  @Expose({ groups: [SerializeGroup.adminList] })
  origin?: ProductResolutionOrigin | null;

  @Index()
  @Column({ type: 'enum', enum: ProductResolutionDecision })
  @Expose({ groups: [SerializeGroup.adminList] })
  decision: ProductResolutionDecision;

  @Column({ type: 'smallint' })
  @Expose({ groups: [SerializeGroup.adminList] })
  similarityScore: number;

  /** `duplicate_detection` only — the two products being compared. Nullable
   *  because `product_resolution` rows frequently have no persisted `ProductModel`
   *  on the input side (that's the reason the resolution pipeline exists). */
  @ManyToOne(() => ProductModel, { onDelete: 'CASCADE', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  productA?: ProductModel | null;

  @ManyToOne(() => ProductModel, { onDelete: 'CASCADE', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  productB?: ProductModel | null;

  /** `product_resolution` only — the `ProductModel` the resolution pipeline
   *  ultimately picked, if resolved. `SET NULL` (not `CASCADE`): this is a
   *  historical audit row that should survive the referenced product later
   *  being merged/deleted, just losing the FK. */
  @ManyToOne(() => ProductModel, { onDelete: 'SET NULL', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  resolvedProduct?: ProductModel | null;

  /** `duplicate_detection`: the single productA-vs-productB comparison.
   *  `product_resolution`: convenience copy of the top candidate's spec match
   *  (full per-candidate detail also lives in `candidates`). */
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  specMatchDetails?: SpecMatchDetails;

  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  pendingReasons?: string[];

  /** `duplicate_detection` only — set when an approve triggers a real merge. */
  @Column({ type: 'timestamptz', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  mergedAt?: Date;

  /** Both flows — set whenever a human approves/rejects any row. */
  @Column({ type: 'timestamptz', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  reviewedAt?: Date;

  @Column({ type: 'text', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  reviewNote?: string | null;

  /** The full input/context the decision was made from. Discriminated by `kind`. */
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  inputSnapshot?:
    | ProductResolutionInputSnapshot
    | ProductDuplicateDetectionInputSnapshot;

  /** Every candidate considered, each with its own gate pass/fail + spec-match
   *  detail. `duplicate_detection` rows carry a single-element array
   *  representing the "other" product, normalized into the same shape. */
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  candidates?: ProductResolutionCandidateRecord[];

  /** `product_resolution` only — the raw `FinalDecision` from the resolution pipeline. */
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  decisionSnapshot?: ProductResolutionDecisionSnapshot;
}
