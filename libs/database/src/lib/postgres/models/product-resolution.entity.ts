import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';
import { BasePostgresEntity } from './base-postgres-entity';
import { ProductModel } from './product-model.entity';
import { ProductSourceRecord } from './product-source-record.entity';
import { ProductResolutionOrigin } from '../types/product-resolution-origin';
import { ProductResolutionFlow } from '../types/product-resolution-flow';
import { ProductResolutionStatus } from '../types/product-resolution-status';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { Expose, Transform } from 'class-transformer';
import { transfromExposeAll } from '@fittkereso-backend/utils';
import {
  ResolutionAiConfidence,
  ResolutionDecidedBy,
  ResolutionReviewTrigger,
} from '../types/product-resolution-review';
import type { SpecMatchDetails } from '../types/spec-match-details';
import type { ProductResolutionAiReview } from '../types/product-resolution-review';
import type { ProductResolutionCandidateRecord } from '../types/product-resolution-candidate';
import type { ProductResolutionDecisionEntry } from '../types/product-resolution-decision-entry';
import type {
  ProductResolutionInputSnapshot,
  ProductDuplicateDetectionInputSnapshot,
} from '../types/product-resolution-input-snapshot';
import type { ProductResolutionDecisionSnapshot } from '../types/product-resolution-decision-snapshot';
import type { ResolutionPriorityBreakdown } from '../types/resolution-priority-breakdown';

/**
 * Unified record of a product-resolution decision, from either of two flows
 * (`flow`): the real-time identity-resolution pipeline (`product_resolution`,
 * `libs/resolution`) or the duplicate-detection system (`duplicate_detection`,
 * nightly cron + scrape-time safety net).
 *
 * Every row is a review-queue item. Its workflow state is `status` (does this
 * still need attention?) plus `accepted` (the human's verdict); the full history
 * of who decided what — system and human alike — lives in the append-only
 * `decisions` log, which is the source of truth those two denormalize.
 *
 * `anchorKey` + `fingerprint` keep the queue idempotent: the same situation seen
 * again never produces a second row, so a decision is never asked for twice.
 */
@Entity()
@Unique(['productA', 'productB'])
// At most one OPEN row per anchor. Decided and superseded rows for the same
// anchor accumulate deliberately (a changed situation gets a fresh row while the
// old decision is preserved), so the constraint is scoped to the open statuses
// rather than applying to the anchor globally.
@Index(['flow', 'anchorKey'], {
  unique: true,
  where: `"anchorKey" IS NOT NULL AND status IN ('pending', 'failed')`,
})
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

  /** Does this row still need attention? The primary review-queue filter. */
  @Index()
  @Column({
    type: 'enum',
    enum: ProductResolutionStatus,
    default: ProductResolutionStatus.pending,
  })
  @Expose({ groups: [SerializeGroup.adminList] })
  status: ProductResolutionStatus;

  /** The verdict, whoever reached it — admin, the deterministic rule, or the AI
   *  reviewer. `decidedBy` says which. False by default, so a declined row and an
   *  undecided row are both `false`; `status` is what distinguishes them. */
  @Column({ type: 'boolean', default: false })
  @Expose({ groups: [SerializeGroup.adminList] })
  accepted: boolean;

  /** Append-only log of every decision made about this row, system and human
   *  alike. Index 0 is always the producing system's own decision. This is the
   *  source of truth `status`/`accepted` denormalize, and the last entry with
   *  `actionPerformed` is what determines which correction can reverse the
   *  current state. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  decisions: ProductResolutionDecisionEntry[];

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

  /**
   * **A human touched this row.** Written by human review actions only —
   * including reopen — and never by automation.
   *
   * That makes it the automation rail: both automated paths require
   * `reviewedAt IS NULL`, so a row you reopened is never silently re-closed by
   * the machine. It stays yours until a rescrape changes the situation, at which
   * point the anchor lifecycle creates a fresh untouched row — a changed
   * situation is a new question.
   */
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

  /** Which real-world situation this row is about — the identity dedup is keyed
   *  on. `product_resolution`: the scraped listing, `${sourceId}:${externalId ?? url}`.
   *  `duplicate_detection`: the ordered product pair, `${productAId}:${productBId}`.
   *  Null for callers with no stable anchor (e.g. the ad-hoc admin resolution
   *  test endpoint), which keeps append-only behavior for them. */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  anchorKey?: string | null;

  /** sha256 over the candidate set, their gate outcomes, and the decision kind —
   *  deliberately NOT the scores, so score jitter is not mistaken for new
   *  information. Only ever compared against another row for the same
   *  `anchorKey`; it is a change detector, not a global identity. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  fingerprint?: string | null;

  /** Last time this exact situation was seen again. Touched on every repeat
   *  sighting, which is also what keeps a row for a still-live listing safe from
   *  retention pruning. */
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  lastSeenAt?: Date | null;

  /** How sure we are the outcome was correct — **whichever outcome it was**,
   *  match or create or reject. Computed by `ResolutionConfidenceService` and
   *  denormalized here so the queue can sort and filter on it without a jsonb
   *  expression. */
  @Index()
  @Column({ type: 'smallint', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  decisionConfidence?: number | null;

  /**
   * 0–100: how important it is that a human reviews this row, and the queue's
   * default order. `uncertainty × impact × statusWeight` — a decision we are
   * sure about scores low however much rides on it, and one touching nothing
   * scores low however unsure we are.
   *
   * An indexed `smallint` is what makes ordering thousands of rows cheap; the
   * same number derived from `priorityBreakdown` at query time would be neither
   * indexable nor fast.
   */
  @Index()
  @Column({ type: 'smallint', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  priority?: number | null;

  /** The terms that produced `priority`, so a surprising rank can be traced to
   *  the one that caused it. */
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  priorityBreakdown?: ResolutionPriorityBreakdown | null;

  /** When priority was last computed. Priority goes stale for reasons the row
   *  itself doesn't record — products gain listings, weights get tuned — so the
   *  nightly sweep works oldest-first from this. */
  @Column({ type: 'timestamptz', nullable: true })
  priorityComputedAt?: Date | null;

  /**
   * Why this row might be wrong — see `ResolutionReviewTrigger`.
   *
   * Computed by `ResolutionReviewTriggerService` and carried in the same
   * `ResolutionScores` struct as the two scores, so every existing write path
   * (insert, refresh, pair upsert, sweep) populates it without a new call site.
   *
   * Three distinct values, and the difference matters: `NULL` means never
   * classified (ineligible for every automated path), `[]` means classified and
   * nothing fired (the value auto-accept trusts), and a non-empty list means at
   * least one suspicion pattern matched.
   *
   * Never an ordering term.
   *
   * The btree index serves the two hot predicates — `= '[]'` (the auto-accept
   * guard, evaluated on the scrape path) and `IS NULL` (the sweep's backfill
   * cursor). The any-of admin filter (`?|`) wants a GIN index instead, which
   * TypeORM's `@Index` cannot express and `synchronize` therefore cannot create;
   * it belongs in the consolidated migration, and until then that filter is an
   * interactive query over a queue of thousands, not a hot path.
   */
  @Index()
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  reviewTriggers?: ResolutionReviewTrigger[] | null;

  /** When the AI reviewer last completed a pass on this row. Cleared whenever
   *  the evidence is refreshed, alongside every other `ai*` column. Drives both
   *  the reviewed/unreviewed filter and intake dedup. */
  @Column({ type: 'timestamptz', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  aiReviewedAt?: Date | null;

  /** How sure the AI was. `high` is what authorises execution; `low`/`medium`
   *  leave the row pending with the recommendation shown as a suggestion — which
   *  makes `aiConfidence IN (low, medium)` the "things the machine couldn't
   *  settle" filter, the queue a human most wants. */
  @Index()
  @Column({
    type: 'enum',
    enum: ResolutionAiConfidence,
    nullable: true,
  })
  @Expose({ groups: [SerializeGroup.adminList] })
  aiConfidence?: ResolutionAiConfidence | null;

  /** The full stored verdict — reasoning, cited evidence, recommended action,
   *  model and cost. Written on every review, whether or not the AI was allowed
   *  to act on it. The reasoning is *also* appended to `decisions` as an entry so
   *  the existing timeline renders it; this is the structured copy the detail
   *  view reads, and it holds only the latest verdict where the log holds all of
   *  them. */
  @Column({ type: 'jsonb', nullable: true })
  @Expose({ groups: [SerializeGroup.adminList] })
  @Transform(transfromExposeAll())
  aiReview?: ProductResolutionAiReview | null;

  /** The row's `fingerprint` when the AI last reviewed it. `aiReviewFingerprint
   *  IS DISTINCT FROM fingerprint` means the situation itself changed since, so
   *  the row becomes eligible for review again — which is what stops the batch
   *  re-judging identical rows every night while still catching real changes. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  aiReviewFingerprint?: string | null;

  /** Who settled this row. The automation audit stream — `decidedBy IN
   *  (system, ai) AND status = done` is "what did the machine close" — and
   *  therefore the spot-check mechanism. Cleared on reopen. */
  @Index()
  @Column({
    type: 'enum',
    enum: ResolutionDecidedBy,
    nullable: true,
  })
  @Expose({ groups: [SerializeGroup.adminList] })
  decidedBy?: ResolutionDecidedBy | null;

  /** The scraped listing this decision was about. Populated for
   *  `product_resolution` rows once the record exists (backfilled right after
   *  `persistProduct` for a first-time scrape). This is what the corrective
   *  actions act on — split carves it out, merge reads its current product —
   *  and it survives merges, since a merge moves source records rather than
   *  deleting them. */
  @ManyToOne(() => ProductSourceRecord, { onDelete: 'SET NULL', nullable: true })
  @Index()
  @Expose({ groups: [SerializeGroup.adminList] })
  sourceRecord?: ProductSourceRecord | null;
}
