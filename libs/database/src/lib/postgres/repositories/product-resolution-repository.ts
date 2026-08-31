import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { isNil, omitBy } from 'lodash';
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
  /** The producing system's own decision — always the first log entry. */
  seedDecision?: ProductResolutionDecisionEntry;
}

/** What `upsertByAnchor` actually did, so callers can log/meter it without
 *  re-deriving it from the returned row. */
export type UpsertByAnchorOutcome = 'unchanged' | 'refreshed' | 'created';

export interface UpsertByAnchorResult {
  resolution: ProductResolution;
  outcome: UpsertByAnchorOutcome;
}

/** Fields a review action writes alongside a new log entry. */
export interface AppendDecisionPatch {
  status?: ProductResolutionStatus;
  accepted?: boolean;
  reviewedAt?: Date;
  reviewNote?: string | null;
  mergedAt?: Date;
  resolvedProductId?: string;
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
    resolution.status = ProductResolutionStatus.pending;
    resolution.accepted = false;
    resolution.decisions = params.seedDecision ? [params.seedDecision] : [];
    resolution.anchorKey = params.anchorKey;
    resolution.fingerprint = params.fingerprint;
    resolution.decisionConfidence = params.decisionConfidence;
    resolution.lastSeenAt = new Date();
    return this.repo.save(resolution);
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
      // Same situation, same content — nothing to review that wasn't already
      // there. Record the sighting (which also protects the row from retention
      // pruning) and leave everything else untouched.
      if (open.fingerprint && open.fingerprint === params.fingerprint) {
        await this.repo.update(open.id, { lastSeenAt: new Date() });
        open.lastSeenAt = new Date();
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

  /** New information for a situation nobody has decided yet: replace the
   *  decision content and put the row back at the front of the queue. */
  private async refreshInPlace(
    existing: ProductResolution,
    params: CreateProductResolutionParams,
  ): Promise<ProductResolution> {
    existing.similarityScore = params.similarityScore;
    existing.specMatchDetails = params.specMatchDetails;
    existing.pendingReasons = params.pendingReasons;
    existing.candidates = params.candidates;
    existing.inputSnapshot = params.inputSnapshot;
    existing.decisionSnapshot = params.decisionSnapshot;
    existing.decisionConfidence = params.decisionConfidence;
    existing.fingerprint = params.fingerprint;
    existing.lastSeenAt = new Date();
    existing.status = ProductResolutionStatus.pending;
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
    if (params.seedDecision) {
      existing.decisions = [...(existing.decisions ?? []), params.seedDecision];
    }
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
   */
  async appendDecision(
    id: string,
    entry: ProductResolutionDecisionEntry,
    patch: AppendDecisionPatch = {},
  ): Promise<void> {
    const { resolvedProductId, ...columns } = patch;
    const set: Record<string, unknown> = {
      ...omitBy(columns, isNil),
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
      seedDecision: params.seedDecision,
    });
  }
}
