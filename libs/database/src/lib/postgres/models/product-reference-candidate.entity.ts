import { Column, Entity, Index, ManyToOne } from "typeorm";
import { Expose } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";
import { BasePostgresEntity } from "./base-postgres-entity";
import { ProductModel } from "./product-model.entity";
import type { ProductReference } from "./product-reference.entity";
import type { Review } from "./review.entity";

@Entity()
@Index(["reference", "model"], { unique: true })
@Index("IDX_product_reference_candidate_primary", ["reference"], {
  unique: true,
  where: '"isPrimary" = true',
})
export class ProductReferenceCandidate extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.adminList] })
  @ManyToOne("ProductReference", "candidates", {
    onDelete: "CASCADE",
    nullable: false,
  })
  reference: ProductReference;

  @Expose({ groups: [SerializeGroup.adminList] })
  @ManyToOne(() => ProductModel, {
    onDelete: "CASCADE",
    nullable: false,
  })
  model: ProductModel;

  @Expose({ groups: [SerializeGroup.adminList] })
  @ManyToOne("Review", "candidates", {
    onDelete: "SET NULL",
    nullable: true,
  })
  review?: Review | null;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "float", nullable: false })
  weight: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "float", nullable: false })
  confidence: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "boolean", nullable: false, default: false })
  isPrimary: boolean;
}

// ─── Candidate-aware read helpers ───────────────────────────────────────────
//
// The primary candidate is the single source of truth for the resolved
// product, its confidence, and the linked review. These helpers centralize
// that lookup so callers don't have to repeat `.candidates?.find(c => c.isPrimary)`
// everywhere.

export function getPrimaryCandidate(
  ref: { candidates?: ProductReferenceCandidate[] } | undefined | null,
): ProductReferenceCandidate | undefined {
  return ref?.candidates?.find((candidate) => candidate.isPrimary);
}

export function getPrimaryModel(
  ref: { candidates?: ProductReferenceCandidate[] } | undefined | null,
): ProductModel | undefined {
  return getPrimaryCandidate(ref)?.model;
}

export function getPrimaryConfidence(
  ref: { candidates?: ProductReferenceCandidate[] } | undefined | null,
): number | undefined {
  return getPrimaryCandidate(ref)?.confidence;
}

export function getPrimaryReview(
  ref: { candidates?: ProductReferenceCandidate[] } | undefined | null,
): Review | undefined | null {
  return getPrimaryCandidate(ref)?.review;
}

/**
 * True when the reference has no resolved product — equivalent to
 * `!ref.resolvedModel` in the pre-candidate world.
 */
export function isUnresolved(
  ref: { candidates?: ProductReferenceCandidate[] } | undefined | null,
): boolean {
  return getPrimaryCandidate(ref) == null;
}
