import { Column, Entity, Index, ManyToOne, OneToMany } from "typeorm";
import { BasePostgresEntity } from "./base-postgres-entity";
import { ProductCategory } from "./product-category.entity";
import { UserComment } from "./user-comment.entity";
import { Depth, ExperienceType, Intent, Sentiment } from "../types/sentiment";
import type { ProductReferenceContext } from "../../models/product-reference-context";
import type { ResolutionContext as PersistedResolutionContext } from "../../models/resolution-context";
import type { StructuredSpec } from "../../models/product-resolution-context";
import { Expose, Transform } from "class-transformer";
import { SerializeGroup, transfromExposeAll } from "@ebike-backend/utils";
import {
  Evidence,
  Quote,
  ReferenceDetails,
} from "../../models/comment-context";
import type { ProductReferenceCandidate } from "./product-reference-candidate.entity";

@Entity()
// Resolution Backfill candidate scan: walk enabled refs in priority order
// (relevance DESC, then attemptResolutionAfter NULLS FIRST, then oldest) so the
// hourly job reads the eligible slice in rank order and stops at LIMIT — no
// full-table sort at scale. The residual filters (unresolved, category, age,
// comment status/relevance) are applied while walking. btree is bidirectional,
// so the ascending index serves the relevance-DESC scan.
@Index(
  "ix_product_reference_backfill",
  ["relevance", "attemptResolutionAfter", "createdAt"],
  { where: '"enabled" = true' },
)
export class ProductReference extends BasePostgresEntity {
  @Expose({ groups: [SerializeGroup.adminList] })
  @ManyToOne(() => UserComment, {
    onDelete: "CASCADE",
    nullable: true,
    orphanedRowAction: "disable",
  })
  comment?: UserComment;

  @ManyToOne(() => ProductCategory, { onDelete: "SET NULL", nullable: true })
  productCategory?: ProductCategory;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ nullable: true })
  categoryHint?: string;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "float", nullable: false })
  relevance: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  @Column({ type: "jsonb", nullable: true })
  quotes?: Quote[];

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "enum", enum: Sentiment, nullable: true })
  sentiment?: Sentiment;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "enum", enum: Intent, nullable: true, array: true })
  intents?: Intent[];

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "enum", enum: ExperienceType, nullable: true })
  experience?: ExperienceType;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "enum", enum: Depth, nullable: true })
  depth?: Depth;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "boolean", nullable: false, default: true })
  enabled: boolean;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "boolean", nullable: false, default: false })
  flagged: boolean;

  /** Evidence emitted by the LLM at the REFERENCE level — labels that summarise
   *  the whole ref across quotes (e.g. "dual use"). Does NOT include labels
   *  derived from individual quotes; those stay on Quote.features / Quote.useCases.
   *  Read-side code that wants the combined view (ref + quote) should use
   *  collectAllFeatures / collectAllUseCases from evidence-collectors. */
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  @Column({ type: "jsonb", nullable: true })
  features?: Evidence[] | null;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  @Column({ type: "jsonb", nullable: true })
  useCases?: Evidence[] | null;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  @Column({ type: "jsonb", nullable: true })
  specs?: StructuredSpec[] | null;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  @Column({ type: "jsonb", nullable: true })
  referenceDetails?: ReferenceDetails;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "boolean", nullable: false, default: false })
  resolutionFinished: boolean;

  /** Number of standalone Resolution Backfill attempts on this reference. Drives
   *  the backoff that sets `attemptResolutionAfter`. Extraction-time resolution
   *  does not increment it (baseline 0). */
  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "int", nullable: false, default: 0 })
  resolutionAttemptCount: number;

  /** Next time the Resolution Backfill scheduler may re-attempt this reference.
   *  NULL = eligible now. Set to `now + effectiveCooldown(resolutionAttemptCount)`
   *  after each attempt (growing, capped backoff); reset to NULL when the world
   *  changes (category linked/enabled, catalog grew) to force an immediate retry. */
  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "timestamptz", nullable: true, default: null })
  attemptResolutionAfter?: Date | null;

  @Expose({ groups: [SerializeGroup.adminDetails, SerializeGroup.adminList] })
  @Column({ nullable: true })
  reviewComment?: string;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "int", nullable: true })
  issueSeverity?: number;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "int", nullable: true })
  openIssueSeverity?: number;

  /** Same-product group, scoped per identification batch then carried across
   *  subtrees by the ProductRegistry. Assigned from the LLM's `linkId` letter;
   *  drives dependency-ordered resolution and backfill candidate propagation. */
  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "uuid", nullable: true })
  productLinkId?: string;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  @Column({ type: "jsonb", nullable: false })
  context: ProductReferenceContext;

  /** Persisted resolution context (snapshot of the resolution run that produced
   *  this reference). See `@ebike-backend/resolution` for the runtime shape;
   *  this is the structurally-mirrored copy that the JSONB column types against. */
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  @Column({ type: "jsonb", nullable: true })
  searchContext?: PersistedResolutionContext;

  @Expose({ groups: [SerializeGroup.adminList] })
  @Column({ type: "timestamptz", nullable: true, default: null })
  resolutionLastAttemptedAt?: Date | null;

  @Expose({ groups: [SerializeGroup.adminList] })
  @OneToMany(
    "ProductReferenceCandidate",
    (candidate: ProductReferenceCandidate) => candidate.reference,
    {
      cascade: ["insert", "update"],
      orphanedRowAction: "delete",
    },
  )
  candidates?: ProductReferenceCandidate[];

  @Expose({ groups: [SerializeGroup.adminList] })
  @Index()
  @Column({ type: "boolean", nullable: false, default: false })
  ambiguousResolution: boolean;
}
