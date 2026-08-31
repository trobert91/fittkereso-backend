import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductResolution } from '../models/product-resolution.entity';
import { ProductModel } from '../models/product-model.entity';
import { ProductResolutionDecision } from '../types/product-resolution-decision';
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
  decision: ProductResolutionDecision;
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
}

export interface UpsertProductResolutionPairParams {
  flow: ProductResolutionFlow;
  productAId: string;
  productBId: string;
  decision: ProductResolutionDecision;
  similarityScore: number;
  specMatchDetails?: SpecMatchDetails;
  pendingReasons?: string[];
  origin?: ProductResolutionOrigin;
  candidates?: ProductResolutionCandidateRecord[];
  inputSnapshot?: ProductDuplicateDetectionInputSnapshot;
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

  /** Flow-agnostic insert. Always creates a new row — no idempotency/upsert
   *  semantics, since the resolution flow's recording is an append-only
   *  decision log, not a pair-tracking workflow. */
  async insert(params: CreateProductResolutionParams): Promise<ProductResolution> {
    const resolution = new ProductResolution();
    resolution.flow = params.flow;
    resolution.decision = params.decision;
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
    resolution.specMatchDetails = params.specMatchDetails;
    resolution.pendingReasons = params.pendingReasons;
    resolution.candidates = params.candidates;
    resolution.inputSnapshot = params.inputSnapshot;
    resolution.decisionSnapshot = params.decisionSnapshot;
    return this.repo.save(resolution);
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
      const terminalDecisions: ProductResolutionDecision[] = [
        ProductResolutionDecision.rejected,
        ProductResolutionDecision.auto_accepted,
        ProductResolutionDecision.approved,
      ];
      if (terminalDecisions.includes(existing.decision)) {
        return existing;
      }

      existing.decision = params.decision;
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
      decision: params.decision,
      similarityScore: params.similarityScore,
      origin: params.origin,
      productAId: orderedAId,
      productBId: orderedBId,
      specMatchDetails: params.specMatchDetails,
      pendingReasons: params.pendingReasons,
      candidates: params.candidates,
      inputSnapshot: params.inputSnapshot,
    });
  }
}
