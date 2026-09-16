import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Unique,
} from 'typeorm';
import { Expose, Transform } from 'class-transformer';
import {
  nameOf,
  SerializeGroup,
  transfromExposeAll,
} from '@fittkereso-backend/utils';
import { BasePostgresEntity } from './base-postgres-entity';
import { ProductModel } from './product-model.entity';
import type {
  CandidateMatchedOn,
  DuplicateDetectedBy,
  DuplicatePairFailedGate,
  NameSimilarity,
} from '../types/product-duplicate-pair.types';

/**
 * Two stored products that look like the same product, waiting for a person
 * to merge or dismiss them — never merged automatically.
 *
 * One row per unordered pair: `productAId` is always the smaller id (the
 * check), so (A, B) and (B, A) can't both exist. Detections refresh an open
 * pair but never reopen a dismissed one.
 */
@Entity()
@Unique([
  nameOf<ProductDuplicatePair>('productAId'),
  nameOf<ProductDuplicatePair>('productBId'),
])
@Check(
  `"${nameOf<ProductDuplicatePair>('productAId')}" < "${nameOf<ProductDuplicatePair>('productBId')}"`,
)
export class ProductDuplicatePair extends BasePostgresEntity {
  // No index of its own: it leads the unique constraint's index.
  @Column({ type: 'uuid' })
  @Expose({ groups: [SerializeGroup.adminList] })
  productAId: string;

  @ManyToOne(() => ProductModel, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: nameOf<ProductDuplicatePair>('productAId') })
  @Expose({ groups: [SerializeGroup.adminList] })
  productA?: ProductModel;

  @Index()
  @Column({ type: 'uuid' })
  @Expose({ groups: [SerializeGroup.adminList] })
  productBId: string;

  @ManyToOne(() => ProductModel, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: nameOf<ProductDuplicatePair>('productBId') })
  @Expose({ groups: [SerializeGroup.adminList] })
  productB?: ProductModel;

  /** The candidate score (1–100) from the latest detection of an open pair. */
  @Column({ type: 'int' })
  @Expose({ groups: [SerializeGroup.adminList] })
  similarityScore: number;

  @Column({ type: 'varchar' })
  @Expose({ groups: [SerializeGroup.adminList] })
  matchedOn: CandidateMatchedOn;

  /** The name key or alias recall matched on. */
  @Column({ type: 'text' })
  @Expose({ groups: [SerializeGroup.adminList] })
  matchedValue: string;

  @Column({ type: 'jsonb' })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  failedGates: DuplicatePairFailedGate[];

  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  nameSimilarity?: NameSimilarity | null;

  @Column({ type: 'varchar' })
  @Expose({ groups: [SerializeGroup.adminList] })
  detectedBy: DuplicateDetectedBy;

  @Column({ type: 'timestamptz', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  dismissedAt?: Date | null;
}
