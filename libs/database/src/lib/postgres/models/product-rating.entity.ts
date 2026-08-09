import { Column, Entity, Index, ManyToOne } from "typeorm";
import { BasePostgresEntity, ProductModel } from ".";
import { SerializeGroup, transfromExposeAll } from "@ebike-backend/utils";
import { Expose, Transform } from "class-transformer";

export interface ProductLabelSummary {
  name: string;
  mentionCount: number;
  strongPositiveCount: number;
  positiveCount: number;
  neutralCount: number;
  mixedCount: number;
  negativeCount: number;
  strongNegativeCount: number;
  score: number;
  /**
   * LLM-generated fields populated by ProductReviewAnalysisService and preserved
   * across per-minute rating recomputes via name-based reconciliation in
   * ProductRatingUpdaterService.aggregateByLabelType.
   */
  headline?: string;
  narrative?: string;
  narrativeGeneratedAt?: string;
}

export interface ProductRatingHighlight {
  text: string;
  quotes: string[];
}

@Entity()
export class ProductRating extends BasePostgresEntity {
  @Index()
  @ManyToOne(() => ProductModel, (model) => model.rating, {
    nullable: false,
    onDelete: "CASCADE",
  })
  model: ProductModel;

  // Sentiment bucket counts are stored as floats because each contributing
  // review carries a `reviewWeight` (max candidate.weight across its
  // candidates pointing at this product). A non-ambiguous review contributes
  // 1.0; an ambiguous review contributes its softmax weight (<1.0). The UI
  // rounds for display; aggregation math uses the float.
  @Index()
  @Column({ type: "float", nullable: false, default: 0 })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  strongPositiveReviewCount: number;

  @Index()
  @Column({ type: "float", nullable: false, default: 0 })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  positiveReviewCount: number;

  @Index()
  @Column({ type: "float", nullable: false, default: 0 })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  negativeReviewCount: number;

  @Index()
  @Column({ type: "float", nullable: false, default: 0 })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  strongNegativeReviewCount: number;

  @Index()
  @Column({ type: "float", nullable: false, default: 0 })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  neutralReviewCount: number;

  @Index()
  @Column({ type: "float", nullable: false, default: 0 })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  mixedReviewCount: number;

  @Index()
  @Column({ type: "float", nullable: false, default: 0 })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  totalReviewCount: number;

  @Index()
  @Column({ type: "int", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  rating?: number | null;

  @Index()
  @Column({ type: "float", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  averageReviewScore?: number | null;

  @Column({ type: "float", nullable: false, default: 0 })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  handsonReviewCount: number;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  @Transform(transfromExposeAll())
  featureSummary?: ProductLabelSummary[] | null;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  @Transform(transfromExposeAll())
  useCaseSummary?: ProductLabelSummary[] | null;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  @Transform(transfromExposeAll())
  issueSummary?: ProductLabelSummary[] | null;

  @Column({ type: "jsonb", nullable: true })
  useCaseScores?: Record<string, number> | null;

  /** Internal flat feature→score map for product-search sort/filter. Not exposed via DTO. */
  @Column({ type: "jsonb", nullable: true })
  featureScores?: Record<string, number> | null;

  /** Internal flat issue→score map for product-search sort/filter. Not exposed via DTO. */
  @Column({ type: "jsonb", nullable: true })
  issueScores?: Record<string, number> | null;

  @Index()
  @Column({ type: "timestamptz", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  lastSummaryGeneratedAt?: Date | null;

  @Column({ type: "int", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  reviewCountAtLastSummary?: number | null;

  @Column({ type: "text", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  tldr?: string | null;

  @Column({ type: "text", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  summary?: string | null;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  @Transform(transfromExposeAll())
  pros?: ProductRatingHighlight[] | null;

  @Column({ type: "jsonb", nullable: true })
  @Expose({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  @Transform(transfromExposeAll())
  cons?: ProductRatingHighlight[] | null;
}
