import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { compact, isEmpty, isNil, isUndefined, omitBy } from 'lodash';
import { nameOf } from '@fittkereso-backend/utils';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductResolution } from '../models/product-resolution.entity';
import { ProductModel } from '../models/product-model.entity';
import { ProductSourceRecord } from '../models/product-source-record.entity';
import {
  OPEN_RESOLUTION_STATUSES,
  ProductResolutionStatus,
} from '../types/product-resolution-status';
import type { ProductResolutionDecisionEntry } from '../types/product-resolution-decision-entry';
import type { ProductResolutionOrigin } from '../types/product-resolution-origin';
import type { ProductResolutionFlow } from '../types/product-resolution-flow';
import type { SpecMatchDetails } from '../types/spec-match-details';
import type { ProductResolutionCandidateRecord } from '../types/product-resolution-candidate';
import type {
  ProductResolutionInputSnapshot,
  ProductDuplicateDetectionInputSnapshot,
} from '../types/product-resolution-input-snapshot';
import type { ProductResolutionDecisionSnapshot } from '../types/product-resolution-decision-snapshot';
import type { ResolutionPriorityBreakdown } from '../types/resolution-priority-breakdown';
import { ResolutionReviewTrigger } from '../types/product-resolution-review';
import type {
  ProductResolutionAiReview,
  ResolutionAiConfidence,
  ResolutionDecidedBy,
} from '../types/product-resolution-review';

/** Flow-agnostic params for the single, always-insert write primitive. This is
 *  the literal shared mechanism both the resolution flow and the
 *  duplicate-detection flow write through (the latter via `upsertPair`, which
 *  delegates to `insert` for its create branch). */
export interface CreateProductResolutionParams {
  flow: ProductResolutionFlow;
  similarityScore: number;
  origin?: ProductResolutionOrigin;
  productAId?: string;
  productBId?: string;
  resolvedProductId?: string;
  specMatchDetails?: SpecMatchDetails;
  pendingReasons?: string[];
  candidates?: ProductResolutionCandidateRecord[];
  inputSnapshot?:
    | ProductResolutionInputSnapshot
    | ProductDuplicateDetectionInputSnapshot;
  decisionSnapshot?: ProductResolutionDecisionSnapshot;
  /** Which situation this row is about — enables idempotent re-recording. */
  anchorKey?: string;
  /** Change detector for the anchor, computed by the recorder. */
  fingerprint?: string;
  sourceRecordId?: string;
  decisionConfidence?: number;
  priority?: number;
  priorityBreakdown?: ResolutionPriorityBreakdown;
  reviewTriggers?: ResolutionReviewTrigger[];
  /** The producing system's own decision — always the first log entry. */
  seedDecision?: ProductResolutionDecisionEntry;
  /**
   * Set when the deterministic trust rule settled this row before it was ever
   * queued, so it is written `done` rather than appearing and being closed a
   * moment later.
   *
   * One object rather than four independent params because the fields have to
   * move together: a `done` row without a `decidedBy`, or without the log entry
   * saying why, would be an unauditable close — and the whole licence for
   * closing rows automatically is that every one of them can be explained and
   * reopened.
   */
  autoAccept?: {
    decidedBy: ResolutionDecidedBy;
    decision: ProductResolutionDecisionEntry;
  };
}

/** One row's rescored values, as written by the nightly sweep. */
export interface ResolutionScoreUpdate {
  id: string;
  decisionConfidence: number;
  priority: number;
  priorityBreakdown: ResolutionPriorityBreakdown;
  reviewTriggers: ResolutionReviewTrigger[];
}

/** What `upsertByAnchor` actually did, so callers can log/meter it without
 *  re-deriving it from the returned row. */
export type UpsertByAnchorOutcome = 'unchanged' | 'refreshed' | 'created';

export interface UpsertByAnchorResult {
  resolution: ProductResolution;
  outcome: UpsertByAnchorOutcome;
}

/**
 * Fields a review action writes alongside a new log entry.
 *
 * `undefined` leaves a column alone; an explicit `null` clears it. The
 * distinction is load-bearing for `decidedBy`, which a reopen has to actively
 * blank — a row back in the queue has no decider, and a stale value would keep
 * it appearing in the automation audit as something the machine had closed.
 */
export interface AppendDecisionPatch {
  status?: ProductResolutionStatus;
  accepted?: boolean;
  reviewedAt?: Date;
  reviewNote?: string | null;
  mergedAt?: Date;
  resolvedProductId?: string;
  decidedBy?: ResolutionDecidedBy | null;
}

export interface UpsertProductResolutionPairParams {
  flow: ProductResolutionFlow;
  productAId: string;
  productBId: string;
  similarityScore: number;
  specMatchDetails?: SpecMatchDetails;
  pendingReasons?: string[];
  origin?: ProductResolutionOrigin;
  candidates?: ProductResolutionCandidateRecord[];
  inputSnapshot?: ProductDuplicateDetectionInputSnapshot;
  anchorKey?: string;
  fingerprint?: string;
  decisionConfidence?: number;
  priority?: number;
  priorityBreakdown?: ResolutionPriorityBreakdown;
  reviewTriggers?: ResolutionReviewTrigger[];
  seedDecision?: ProductResolutionDecisionEntry;
}

@Injectable()
export class ProductResolutionRepository extends BasePostgresRepository<ProductResolution> {
  constructor(
    @InjectRepository(ProductResolution, 'postgres')
    repository: Repository<ProductResolution>,
  ) {
    super(repository, ProductResolution);
  }

  async findExistingPair(
    productAId: string,
    productBId: string,
  ): Promise<ProductResolution | null> {
    const [orderedA, orderedB] =
      productAId < productBId
        ? [productAId, productBId]
        : [productBId, productAId];

    return this.repo.findOne({
      where: {
        productA: { id: orderedA },
        productB: { id: orderedB },
      },
      relations: [
        nameOf<ProductResolution>('productA'),
        nameOf<ProductResolution>('productB'),
      ],
    });
  }

  /** Flow-agnostic insert. Always creates a new row. Callers that can supply an
   *  `anchorKey` should go through `upsertByAnchor` instead — this stays the
   *  create branch both it and `upsertPair` delegate to, and the direct path for
   *  callers with no stable anchor (e.g. the ad-hoc admin test endpoint). */
  async insert(params: CreateProductResolutionParams): Promise<ProductResolution> {
    const resolution = new ProductResolution();
    resolution.flow = params.flow;
    resolution.similarityScore = params.similarityScore;
    resolution.origin = params.origin;
    if (params.productAId) {
      resolution.productA = { id: params.productAId } as ProductModel;
    }
    if (params.productBId) {
      resolution.productB = { id: params.productBId } as ProductModel;
    }
    if (params.resolvedProductId) {
      resolution.resolvedProduct = { id: params.resolvedProductId } as ProductModel;
    }
    if (params.sourceRecordId) {
      resolution.sourceRecord = {
        id: params.sourceRecordId,
      } as ProductSourceRecord;
    }
    resolution.specMatchDetails = params.specMatchDetails;
    resolution.pendingReasons = params.pendingReasons;
    resolution.candidates = params.candidates;
    resolution.inputSnapshot = params.inputSnapshot;
    resolution.decisionSnapshot = params.decisionSnapshot;
    // A trusted row is born decided. It never enters the queue, which is the
    // point — the queue should only ever hold rows something actually doubted.
    resolution.status = params.autoAccept
      ? ProductResolutionStatus.done
      : ProductResolutionStatus.pending;
    resolution.accepted = !!params.autoAccept;
    resolution.decidedBy = params.autoAccept?.decidedBy ?? null;
    resolution.decisions = compact([
      params.seedDecision,
      params.autoAccept?.decision,
    ]);
    resolution.anchorKey = params.anchorKey;
    resolution.fingerprint = params.fingerprint;
    resolution.lastSeenAt = new Date();
    this.applyScores(resolution, params);
    return this.repo.save(resolution);
  }

  /**
   * The denormalized derived values, always written together.
   *
   * They are all derived from the same decision content, so a path that
   * refreshed one and not the others would leave a row ranked by evidence it no
   * longer carries — or, worse for `reviewTriggers`, classified against evidence
   * that has since changed while still reading as trustworthy to auto-accept.
   * That is exactly the kind of drift nobody notices.
   *
   * `reviewTriggers` is left `null` when the caller supplied none, which is the
   * "never classified" state — deliberately distinct from `[]`, and ineligible
   * for every automated path.
   */
  private applyScores(
    resolution: ProductResolution,
    params: Pick<
      CreateProductResolutionParams,
      'decisionConfidence' | 'priority' | 'priorityBreakdown' | 'reviewTriggers'
    >,
  ): void {
    resolution.decisionConfidence = params.decisionConfidence;
    resolution.priority = params.priority;
    resolution.priorityBreakdown = params.priorityBreakdown;
    resolution.reviewTriggers = params.reviewTriggers ?? null;
    resolution.priorityComputedAt = isNil(params.priority) ? null : new Date();
  }

  /** The one open (still-needs-attention) row for a situation, if any. Decided
   *  and superseded rows for the same anchor are history and never returned. */
  async findOpenByAnchor(
    flow: ProductResolutionFlow,
    anchorKey: string,
  ): Promise<ProductResolution | null> {
    return this.repo.findOne({
      where: { flow, anchorKey, status: In(OPEN_RESOLUTION_STATUSES) },
    });
  }

  /**
   * Idempotent recording keyed on the situation (`anchorKey`) rather than the
   * write. This is what stops the same decision being asked for twice: an
   * unchanged situation never produces a second row no matter how often it is
   * re-scraped, while a genuinely changed one comes back for review without
   * overwriting what a human already decided.
   */
  async upsertByAnchor(
    params: CreateProductResolutionParams & { anchorKey: string },
  ): Promise<UpsertByAnchorResult> {
    const open = await this.findOpenByAnchor(params.flow, params.anchorKey);

    if (open) {
      // Same situation, same question to answer — so the row keeps its place in
      // the queue, its status and its decision log. But "same situation" is
      // narrower than "same evidence": the fingerprint covers candidate ids and
      // gate outcomes only, so scores, spec comparisons and match components can
      // all have improved since. Those are what a reviewer reads, so take the
      // fresh copy rather than leaving a permanently staler one in place.
      if (open.fingerprint && open.fingerprint === params.fingerprint) {
        await this.refreshEvidence(open, params);
        return { resolution: open, outcome: 'unchanged' };
      }

      return {
        resolution: await this.refreshInPlace(open, params),
        outcome: 'refreshed',
      };
    }

    // No open row. A decided row for the same anchor with the same fingerprint
    // means this question is settled — touch it and stay quiet.
    const settled = await this.repo.findOne({
      where: { flow: params.flow, anchorKey: params.anchorKey },
      order: { createdAt: 'DESC' },
    });

    if (settled) {
      if (settled.fingerprint && settled.fingerprint === params.fingerprint) {
        await this.repo.update(settled.id, { lastSeenAt: new Date() });
        settled.lastSeenAt = new Date();
        return { resolution: settled, outcome: 'unchanged' };
      }
      // The situation changed after it was decided. The old decision stays as
      // audit; a fresh row carries the new information back into the queue.
      await this.markSuperseded(settled.id);
    }

    try {
      return { resolution: await this.insert(params), outcome: 'created' };
    } catch (error: unknown) {
      // Lost the race for the partial unique index — the concurrent winner's
      // row is now the open one, so update that instead of inserting a second.
      const concurrent = await this.findOpenByAnchor(
        params.flow,
        params.anchorKey,
      );
      if (!concurrent) {
        throw error;
      }
      return {
        resolution: await this.refreshInPlace(concurrent, params),
        outcome: 'refreshed',
      };
    }
  }

  /**
   * Same situation, fresher evidence: update what the reviewer reads and
   * nothing else.
   *
   * Deliberately narrower than `refreshInPlace` — no status reset, no decision
   * entry, no fingerprint change, so the row does not move in the queue and
   * nothing about it reads as new. Scores and `reviewTriggers` are left to the
   * nightly sweep, which recomputes them from the row against its real status;
   * recomputing here would have to assume `pending`.
   *
   * That leaves a window where the triggers describe the previous scores — the
   * candidate ids and gate outcomes are identical by definition (that is what the
   * matching fingerprint means), but a `matchScore` can have moved. Harmless by
   * construction: record-time auto-accept classifies from freshly computed
   * triggers rather than from this column, and the nightly catch-up runs *after*
   * the sweep, which is why that ordering is load-bearing.
   *
   * Only ever called for an open row. A decided row's snapshot is the record of
   * what was decided on, so rewriting its evidence would rewrite history.
   */
  private async refreshEvidence(
    open: ProductResolution,
    params: CreateProductResolutionParams,
  ): Promise<void> {
    const lastSeenAt = new Date();
    await this.repo.update(open.id, {
      lastSeenAt,
      candidates: params.candidates,
      specMatchDetails: params.specMatchDetails,
    });
    open.lastSeenAt = lastSeenAt;
    open.candidates = params.candidates;
    open.specMatchDetails = params.specMatchDetails;
  }

  /**
   * New information for a situation nobody has decided yet: replace the decision
   * content and put the row back at the front of the queue.
   *
   * The trust rule applies here too — a refreshed situation that now clears it
   * should settle rather than queue — **except on a row a human has touched**.
   * That guard has to live here rather than in the recorder, because only this
   * method can see the existing row's `reviewedAt`; the recorder is describing a
   * situation, not a row. A row you reopened stays yours until a rescrape changes
   * the situation enough to supersede it, at which point the fresh row is
   * untouched and eligible again.
   */
  private async refreshInPlace(
    existing: ProductResolution,
    params: CreateProductResolutionParams,
  ): Promise<ProductResolution> {
    const autoAccept = existing.reviewedAt ? undefined : params.autoAccept;

    existing.similarityScore = params.similarityScore;
    existing.specMatchDetails = params.specMatchDetails;
    existing.pendingReasons = params.pendingReasons;
    existing.candidates = params.candidates;
    existing.inputSnapshot = params.inputSnapshot;
    existing.decisionSnapshot = params.decisionSnapshot;
    existing.fingerprint = params.fingerprint;
    existing.lastSeenAt = new Date();
    existing.status = autoAccept
      ? ProductResolutionStatus.done
      : ProductResolutionStatus.pending;
    existing.accepted = !!autoAccept;
    existing.decidedBy = autoAccept?.decidedBy ?? null;
    this.applyScores(existing, params);
    if (params.resolvedProductId) {
      existing.resolvedProduct = {
        id: params.resolvedProductId,
      } as ProductModel;
    }
    if (params.sourceRecordId) {
      existing.sourceRecord = {
        id: params.sourceRecordId,
      } as ProductSourceRecord;
    }
    existing.decisions = [
      ...(existing.decisions ?? []),
      ...compact([params.seedDecision, autoAccept?.decision]),
    ];
    // The situation changed, so any AI verdict describes evidence this row no
    // longer carries. Clearing all four together is what guarantees a stale
    // verdict is never displayed beside fresh evidence — and it makes the row
    // eligible for review again, which is the correct outcome.
    existing.aiReview = null;
    existing.aiConfidence = null;
    existing.aiReviewedAt = null;
    existing.aiReviewFingerprint = null;
    return this.repo.save(existing);
  }

  async markSuperseded(id: string): Promise<void> {
    await this.repo.update(id, {
      status: ProductResolutionStatus.superseded,
    });
  }

  /**
   * Appends one decision-log entry and applies the workflow fields that go with
   * it. The append is a single `decisions || entry` statement rather than a
   * read-modify-write so two concurrent actions can't drop each other's entry.
   *
   * Only `undefined` is skipped, not every nullish value: a caller passing an
   * explicit `null` means "clear this column", which is how a reopen blanks
   * `decidedBy`. Filtering on `isNil` instead would silently turn that clear into
   * a no-op and leave the row claiming a decider it no longer has.
   */
  async appendDecision(
    id: string,
    entry: ProductResolutionDecisionEntry,
    patch: AppendDecisionPatch = {},
  ): Promise<void> {
    const { resolvedProductId, ...columns } = patch;
    const set: Record<string, unknown> = {
      ...omitBy(columns, isUndefined),
      decisions: () => `decisions || :entry::jsonb`,
    };
    if (resolvedProductId) {
      set[`${nameOf<ProductResolution>('resolvedProduct')}Id`] =
        resolvedProductId;
    }

    await this.repo
      .createQueryBuilder()
      .update(ProductResolution)
      .set(set)
      .where('id = :id', { id })
      .setParameter('entry', JSON.stringify([entry]))
      .execute();
  }

  /** One loader with every relation the state derivation and the detail view
   *  need, so the controller and the orchestrator can't drift apart on which
   *  relations are present. */
  async findForAction(id: string): Promise<ProductResolution | null> {
    const sourceRecord = nameOf<ProductResolution>('sourceRecord');
    return this.repo.findOne({
      where: { id },
      relations: [
        nameOf<ProductResolution>('productA'),
        nameOf<ProductResolution>('productB'),
        nameOf<ProductResolution>('resolvedProduct'),
        sourceRecord,
        `${sourceRecord}.${nameOf<ProductSourceRecord>('source')}`,
        `${sourceRecord}.${nameOf<ProductSourceRecord>('model')}`,
      ],
    });
  }

  /**
   * The next rows due a rescore, oldest first, with only the *ids* of the
   * products each one touches.
   *
   * The joins select `id` and nothing else: the sweep needs to know which
   * products a row affects so it can count what rides on them, not what those
   * products contain. Ordering on `priorityComputedAt` is what makes the sweep
   * self-advancing — every row it writes moves behind the cursor — so it needs
   * no offset paging and cannot revisit a row within a run.
   */
  async findStalePriorityBatch(
    computedBefore: Date,
    limit: number,
  ): Promise<ProductResolution[]> {
    const computedAt = nameOf<ProductResolution>('priorityComputedAt');

    return this.repo
      .createQueryBuilder('resolution')
      .leftJoin(
        `resolution.${nameOf<ProductResolution>('sourceRecord')}`,
        'sourceRecord',
      )
      .addSelect('sourceRecord.id')
      .leftJoin(
        `sourceRecord.${nameOf<ProductSourceRecord>('model')}`,
        'listingProduct',
      )
      .addSelect('listingProduct.id')
      .leftJoin(
        `resolution.${nameOf<ProductResolution>('productA')}`,
        'productA',
      )
      .addSelect('productA.id')
      .leftJoin(
        `resolution.${nameOf<ProductResolution>('productB')}`,
        'productB',
      )
      .addSelect('productB.id')
      .leftJoin(
        `resolution.${nameOf<ProductResolution>('resolvedProduct')}`,
        'resolvedProduct',
      )
      .addSelect('resolvedProduct.id')
      .where(
        `(resolution.${computedAt} IS NULL OR resolution.${computedAt} < :computedBefore)`,
        { computedBefore },
      )
      .orderBy(`resolution.${computedAt}`, 'ASC', 'NULLS FIRST')
      .limit(limit)
      .getMany();
  }

  /**
   * Writes a whole batch's scores in one statement.
   *
   * Deliberately raw rather than `save()`: the values differ per row, so the ORM
   * would issue one UPDATE each, and at thousands of rows a night that is the
   * cost that decides whether the sweep is viable.
   *
   * It also, deliberately, does **not** touch `updatedAt` — a rescore is not a
   * modification anyone made. `pruneSuperseded` ages rows on `updatedAt`, so a
   * sweep that bumped it would quietly make superseded rows immortal.
   */
  async updateScores(updates: ResolutionScoreUpdate[]): Promise<number> {
    if (isEmpty(updates)) return 0;

    const params: unknown[] = [];
    const values = updates
      .map((update) => {
        const base = params.length;
        params.push(
          update.id,
          update.decisionConfidence,
          update.priority,
          JSON.stringify(update.priorityBreakdown),
          JSON.stringify(update.reviewTriggers),
        );
        return `($${base + 1}::uuid, $${base + 2}::smallint, $${base + 3}::smallint, $${base + 4}::jsonb, $${base + 5}::jsonb)`;
      })
      .join(', ');

    await this.repo.query(
      `UPDATE "${this.repo.metadata.tableName}" AS target
       SET "${nameOf<ProductResolution>('decisionConfidence')}" = source.confidence,
           "${nameOf<ProductResolution>('priority')}" = source.priority,
           "${nameOf<ProductResolution>('priorityBreakdown')}" = source.breakdown,
           "${nameOf<ProductResolution>('reviewTriggers')}" = source.triggers,
           "${nameOf<ProductResolution>('priorityComputedAt')}" = now()
       FROM (VALUES ${values}) AS source(id, confidence, priority, breakdown, triggers)
       WHERE target.id = source.id`,
      params,
    );

    return updates.length;
  }

  /**
   * Pending rows the deterministic trust rule looks likely to settle, best-scored
   * first.
   *
   * A **pre-filter, not the rule itself.** It exists to keep the nightly pass
   * from loading a queue's worth of rows to reject nearly all of them, and every
   * clause here is re-asserted per row in TypeScript before anything is written
   * — by the same predicate the record-time path uses, so the two can never
   * drift into disagreeing about what "trusted" means. If they ever did, the
   * TypeScript side wins and the row is skipped.
   *
   * Ordered by confidence rather than priority: this pass is about clearing the
   * rows nobody needs to see, and the most certain ones are the safest to take
   * first when the cap cuts the batch short.
   */
  async findTrustedPendingBatch(
    flow: ProductResolutionFlow,
    minConfidence: number,
    limit: number,
  ): Promise<ProductResolution[]> {
    return this.repo
      .createQueryBuilder('resolution')
      .leftJoinAndSelect(
        `resolution.${nameOf<ProductResolution>('sourceRecord')}`,
        'sourceRecord',
      )
      .where(`resolution.${nameOf<ProductResolution>('flow')} = :flow`, { flow })
      .andWhere(`resolution.${nameOf<ProductResolution>('status')} = :status`, {
        status: ProductResolutionStatus.pending,
      })
      .andWhere(`resolution.${nameOf<ProductResolution>('reviewedAt')} IS NULL`)
      .andWhere(
        `resolution.${nameOf<ProductResolution>('reviewTriggers')} = '[]'::jsonb`,
      )
      .andWhere(
        `resolution.${nameOf<ProductResolution>('decisionConfidence')} >= :minConfidence`,
        { minConfidence },
      )
      .orderBy(
        `resolution.${nameOf<ProductResolution>('decisionConfidence')}`,
        'DESC',
      )
      .limit(limit)
      .getMany();
  }

  /**
   * Stores one AI verdict, stamped with the fingerprint it was formed against.
   *
   * That stamp is the whole dedup mechanism: `aiReviewFingerprint IS DISTINCT
   * FROM fingerprint` means the situation itself changed since the model looked,
   * so the row becomes eligible again. Without it the batch would either
   * re-judge identical rows every night or never revisit one that genuinely
   * changed.
   */
  async saveAiReview(
    id: string,
    params: {
      review: ProductResolutionAiReview;
      confidence: ResolutionAiConfidence;
      fingerprint?: string | null;
    },
  ): Promise<void> {
    await this.repo.update(id, {
      aiReview: params.review,
      aiConfidence: params.confidence,
      aiReviewedAt: new Date(),
      aiReviewFingerprint: params.fingerprint ?? null,
    });
  }

  /** Superseded rows are pure noise once a newer row exists — age them on their
   *  own timestamp. */
  async pruneSuperseded(olderThan: Date): Promise<number> {
    const result = await this.repo.delete({
      status: ProductResolutionStatus.superseded,
      updatedAt: LessThan(olderThan),
    });
    return result.affected ?? 0;
  }

  /**
   * Decided rows are aged on `lastSeenAt`, NOT on when they were decided: a
   * decided row is what stops the same question being asked again, so deleting
   * one whose listing is still being scraped would resurrect the repetition.
   * Every repeat sighting touches `lastSeenAt`, so an active listing keeps its
   * row indefinitely and only genuinely quiet ones are pruned.
   */
  async pruneDoneNotSeenSince(cutoff: Date): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .from(ProductResolution)
      .where('status = :status', { status: ProductResolutionStatus.done })
      .andWhere(
        'COALESCE("lastSeenAt", "reviewedAt", "updatedAt") < :cutoff',
        { cutoff },
      )
      .execute();
    return result.affected ?? 0;
  }

  /**
   * The next rows worth spending an LLM call on, most important first.
   *
   * Ordered by `priority` — the same order the admin queue shows — so the AI and
   * a human work the same list from the same end, and whatever one clears the
   * other does not see again. That is the whole day/night handoff; it needs no
   * coordination machinery beyond this ORDER BY.
   *
   * The exclusions each buy something:
   *  - `failed` rows are left out (only `pending` is selected): the blocker there
   *    is environmental, and no amount of judgement fixes a merge that threw.
   *  - `reviewedAt IS NULL` — the same rail the deterministic path respects.
   *  - unclassified rows are skipped, because the triggers are what route the
   *    prompt; without them the model gets a generic question.
   *  - `insufficient_evidence` rows are skipped outright. That trigger means
   *    nothing was recalled and the input named neither brand nor model — there
   *    is nothing to judge, so a call would buy an abstain at full price.
   *  - a row already reviewed comes back only if its situation changed
   *    (`aiReviewFingerprint` no longer matches) or the verdict has aged out.
   */
  async findAiReviewBatch(params: {
    minPriority: number;
    reReviewAfterDays: number;
    limit: number;
  }): Promise<ProductResolution[]> {
    const staleBefore = new Date();
    staleBefore.setDate(staleBefore.getDate() - params.reReviewAfterDays);

    const column = <K extends keyof ProductResolution>(field: K) =>
      `resolution.${nameOf<ProductResolution>(field)}`;

    return this.repo
      .createQueryBuilder('resolution')
      .leftJoinAndSelect(
        `resolution.${nameOf<ProductResolution>('sourceRecord')}`,
        'sourceRecord',
      )
      .where(`${column('status')} = :status`, {
        status: ProductResolutionStatus.pending,
      })
      .andWhere(`${column('reviewedAt')} IS NULL`)
      .andWhere(`${column('reviewTriggers')} IS NOT NULL`)
      .andWhere(
        `NOT jsonb_exists(${column('reviewTriggers')}, :unjudgeable)`,
        { unjudgeable: ResolutionReviewTrigger.insufficient_evidence },
      )
      .andWhere(`${column('priority')} >= :minPriority`, {
        minPriority: params.minPriority,
      })
      .andWhere(
        `(${column('aiReviewedAt')} IS NULL
          OR ${column('aiReviewFingerprint')} IS DISTINCT FROM ${column('fingerprint')}
          OR ${column('aiReviewedAt')} < :staleBefore)`,
        { staleBefore },
      )
      .orderBy(`${column('priority')}`, 'DESC', 'NULLS LAST')
      .addOrderBy(`${column('createdAt')}`, 'DESC')
      .limit(params.limit)
      .getMany();
  }

  /**
   * Pending rows nobody will ever judge, aged on `lastSeenAt` like the decided
   * ones — an undecided row for a listing still being scraped is a live question,
   * however old.
   *
   * `failed` is excluded deliberately, even though it is also an open status: a
   * failed row means a catalog action errored and is still broken. Ageing those
   * out would delete the evidence of a bug rather than tidy a queue.
   */
  async prunePendingNotSeenSince(cutoff: Date): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .from(ProductResolution)
      .where('status = :status', { status: ProductResolutionStatus.pending })
      .andWhere('COALESCE("lastSeenAt", "updatedAt") < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }

  /** Idempotent find-or-update-or-create for `duplicate_detection` pairs.
   *  Refuses to overwrite terminal decisions (protects a human-reviewed or
   *  auto-settled pair from being silently clobbered by a later automated
   *  nightly re-evaluation — unrelated to whether an admin can later act on
   *  it via the controller). Delegates to `insert` for the create branch. */
  async upsertPair(
    params: UpsertProductResolutionPairParams,
  ): Promise<ProductResolution | null> {
    const [orderedAId, orderedBId] =
      params.productAId < params.productBId
        ? [params.productAId, params.productBId]
        : [params.productBId, params.productAId];

    const existing = await this.repo.findOne({
      where: {
        productA: { id: orderedAId },
        productB: { id: orderedBId },
      },
    });

    if (existing) {
      // A human already settled this pair — a later automated re-evaluation
      // must not quietly reopen or overwrite it. Record the sighting only.
      if (
        existing.status === ProductResolutionStatus.done ||
        existing.status === ProductResolutionStatus.superseded
      ) {
        await this.repo.update(existing.id, { lastSeenAt: new Date() });
        return existing;
      }

      existing.similarityScore = params.similarityScore;
      existing.specMatchDetails = params.specMatchDetails;
      existing.pendingReasons = params.pendingReasons;
      // Simplest policy: the most recent upsert's origin wins, same as every
      // other field here. A scrape_time pair the nightly job re-evaluates
      // becomes nightly_detection-tagged going forward — the nightly job's
      // fresher, full-catalog scoring is treated as authoritative.
      existing.origin = params.origin ?? existing.origin;
      existing.candidates = params.candidates;
      existing.inputSnapshot = params.inputSnapshot;
      existing.anchorKey = params.anchorKey ?? existing.anchorKey;
      existing.fingerprint = params.fingerprint ?? existing.fingerprint;
      existing.lastSeenAt = new Date();
      // The pair was re-scored above, so its derived scores must move with it.
      this.applyScores(existing, params);
      if (params.seedDecision) {
        existing.decisions = [
          ...(existing.decisions ?? []),
          params.seedDecision,
        ];
      }
      return this.repo.save(existing);
    }

    const [productAExists, productBExists] = await Promise.all([
      this.repo.manager.exists('ProductModel', { where: { id: orderedAId } }),
      this.repo.manager.exists('ProductModel', { where: { id: orderedBId } }),
    ]);

    if (!productAExists || !productBExists) {
      return null;
    }

    return this.insert({
      flow: params.flow,
      similarityScore: params.similarityScore,
      origin: params.origin,
      productAId: orderedAId,
      productBId: orderedBId,
      specMatchDetails: params.specMatchDetails,
      pendingReasons: params.pendingReasons,
      candidates: params.candidates,
      inputSnapshot: params.inputSnapshot,
      anchorKey: params.anchorKey,
      fingerprint: params.fingerprint,
      decisionConfidence: params.decisionConfidence,
      priority: params.priority,
      priorityBreakdown: params.priorityBreakdown,
      reviewTriggers: params.reviewTriggers,
      seedDecision: params.seedDecision,
    });
  }
}
