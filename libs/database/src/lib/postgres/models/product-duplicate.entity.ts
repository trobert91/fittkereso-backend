import { Column, Entity, Index, ManyToOne, Unique } from "typeorm";
import { BasePostgresEntity } from "./base-postgres-entity";
import { ProductModel } from "./product-model.entity";
import { ProductDuplicateDecision } from "../types/product-duplicate-decision";
import { SerializeGroup } from "@ebike-backend/utils";
import { Expose, Transform } from "class-transformer";
import { transfromExposeAll } from "@ebike-backend/utils";
import type { SpecMatchDetails } from "../types/spec-match-details";

@Entity()
@Unique(["productA", "productB"])
export class ProductDuplicate extends BasePostgresEntity {
  @ManyToOne(() => ProductModel, { onDelete: "CASCADE", nullable: false })
  @Expose({ groups: [SerializeGroup.adminList] })
  productA: ProductModel;

  @ManyToOne(() => ProductModel, { onDelete: "CASCADE", nullable: false })
  @Expose({ groups: [SerializeGroup.adminList] })
  productB: ProductModel;

  @Index()
  @Column({
    type: "enum",
    enum: ProductDuplicateDecision,
    default: ProductDuplicateDecision.pending_review,
  })
  @Expose({ groups: [SerializeGroup.adminList] })
  decision: ProductDuplicateDecision;

  @Column({ type: "smallint" })
  @Expose({ groups: [SerializeGroup.adminList] })
  similarityScore: number;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  specMatchDetails?: SpecMatchDetails;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  pendingReasons?: string[];

  @Column({ type: "timestamptz", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  mergedAt?: Date;

  @Column({ type: "timestamptz", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  reviewedAt?: Date;

  @Column({ type: "text", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  reviewNote?: string | null;
}
