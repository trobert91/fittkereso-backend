import { Injectable } from "@nestjs/common";
import { In } from "typeorm";
import { isEmpty, sortBy } from "lodash";
import {
  ProductModel,
  ProductModelRepository,
  ProductReference,
  ProductReferenceCandidate,
  ProductReferenceCandidateRepository,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { nameOf } from "@ebike-backend/utils";
import type { ResolutionResult } from "./models/resolution-result";
import type { ResolutionRegistryUpdater } from "./registry-updater";

const SOFTMAX_TAU = 5;

export interface ApplyOptions {
  /** Comment body text. Retained for trace/debug purposes; no longer drives any
   *  filtering decision (previously fed ambiguity-detection substring suppression
   *  which has been removed). */
  commentBody: string;
  /**
   * Optional registry hook invoked after the candidate set is persisted. When
   * supplied, the applier guarantees the consumer's registry entry reflects
   * the new candidate set — this is the single-write-site invariant that lets
   * downstream `referenced`-type identification trust the registry to carry
   * full candidate sets (including ambiguity).
   *
   * Omit for callsites that don't carry a thread-scoped registry — deferred
   * retry, admin overrides, product-merge, etc.
   */
  registry?: ResolutionRegistryUpdater;
}

/**
 * Single owner of `ProductReference.candidates` writes. Called from every
 * resolution callsite (full search, variant search, registry lock paths,
 * deferred-retry, re-extraction reset) so candidate-set construction stays
 * consistent across the pipeline.
 *
 * One pick = one `ProductReferenceCandidate` row. The decision's
 * `selectedCandidates` array is the single source of truth for which catalog
 * SKUs the resolution settled on. The applier explicitly sorts picks by
 * confidence descending (defensive — strategies already sort, but making the
 * applier own this guarantees a single source of truth for "which pick is
 * primary"). The first surviving candidate (post model-load) is marked primary.
 *
 * Weights are assigned via softmax (τ = 5) across the surviving set so a
 * 78/76 best-vs-second pair yields roughly 55%/45% rather than collapsing
 * toward 50/50.
 *
 * The helper deletes any existing candidates for the reference before writing,
 * so re-resolution paths (`reResolveIfNewSpecs`, deferred retry) don't leave
 * stale rows behind.
 */
@Injectable()
export class ResolutionResultApplierService {
  private readonly logger = new CustomLogger(
    ResolutionResultApplierService.name,
  );

  constructor(
    private readonly candidateRepository: ProductReferenceCandidateRepository,
    private readonly productModelRepository: ProductModelRepository,
  ) {}

  async apply(
    ref: ProductReference,
    result: ResolutionResult,
    options: ApplyOptions,
  ): Promise<void> {
    await this.deleteExistingCandidates(ref);

    const decision = result.context.decision;
    const picks = decision?.selectedCandidates ?? [];

    if (!result.resolvedModel || picks.length === 0) {
      ref.candidates = [];
      ref.ambiguousResolution = false;
      return;
    }

    // Defensive: explicitly sort picks by confidence descending before assigning
    // isPrimary, so the applier doesn't rely on the caller's invariant.
    // Strategies (LlmDecisionStrategy, DecisionService.matcher_accept) already
    // sort, but making the applier own this guarantees a single source of truth
    // for "which pick is primary" — and a future strategy that forgets to sort
    // doesn't silently corrupt the candidate ordering.
    const sortedPicks = sortBy(picks, (pick) => -pick.confidence);

    const models = await this.loadModels(
      sortedPicks.map((pick) => pick.candidateId),
    );
    const built: ProductReferenceCandidate[] = [];
    for (const pick of sortedPicks) {
      const model = models.get(pick.candidateId);
      if (!model) {
        this.logger.warn("Resolution pick references unknown candidate", {
          referenceId: ref.id,
          candidateId: pick.candidateId,
        });
        continue;
      }
      built.push(
        this.buildCandidate({
          ref,
          modelId: model.id,
          model,
          score: pick.confidence,
          // isPrimary is set AFTER the loop based on built[0], so model-load
          // failures on the highest-confidence pick don't leave the candidate
          // set without a primary.
          isPrimary: false,
        }),
      );
    }

    if (built.length === 0) {
      ref.candidates = [];
      ref.ambiguousResolution = false;
      // Suppress registry sync — there's nothing to surface and clearing the
      // candidate set on a thread-scoped registry entry could thrash sibling
      // resolutions. Match the no-resolved-model branch above.
      return;
    }

    // After model-load filtering, the highest-confidence surviving pick is primary.
    built[0].isPrimary = true;

    this.assignSoftmaxWeights(built);

    // Single round-trip — built[0] is primary (set above), and save() preserves
    // input order, so the returned array keeps primary-first.
    ref.candidates = await this.candidateRepository.repo.save(built);
    ref.ambiguousResolution = ref.candidates.length > 1;
    options.registry?.syncFromReference(ref);
  }

  /**
   * Replace the candidate set with a single primary candidate referring to the
   * given model. Used by admin overrides and AutoFix paths that pick a product
   * directly without re-running the resolver. Wipes any runners-up.
   *
   * Confidence defaults to 100 (admin override); pass a custom value if the
   * caller has a meaningful score for the override.
   *
   * The registry hook is intentionally not invoked here — admin overrides and
   * AutoFix run outside the thread-scoped registry's lifecycle. If a caller
   * needs the registry refreshed after a manual override, it should call the
   * registry's update method directly.
   */
  async setPrimaryCandidate(
    ref: ProductReference,
    model: ProductModel,
    confidence = 100,
  ): Promise<void> {
    await this.deleteExistingCandidates(ref);

    const primaryCandidate = this.buildCandidate({
      ref,
      modelId: model.id,
      model,
      score: confidence,
      isPrimary: true,
    });
    primaryCandidate.weight = 1;

    const saved = await this.candidateRepository.repo.save(primaryCandidate);

    ref.candidates = [saved];
    ref.ambiguousResolution = false;
  }

  /**
   * Copy a pre-existing candidate set onto this reference. Used by the
   * `referenced` identification routing path: when the LLM marks a comment as
   * a back-reference to a name already in the thread's `ProductRegistry`,
   * we replicate the parent's full candidate set on the new reference
   * instead of running the resolver again — preserving the original
   * ambiguity. The supplied snapshot is the registry's `candidateSet` field.
   */
  async copyCandidateSet(
    ref: ProductReference,
    snapshot: ReadonlyArray<{
      model: ProductModel;
      weight: number;
      confidence: number;
      isPrimary: boolean;
    }>,
    registry?: ResolutionRegistryUpdater,
  ): Promise<void> {
    await this.deleteExistingCandidates(ref);

    if (snapshot.length === 0) {
      ref.candidates = [];
      ref.ambiguousResolution = false;
      registry?.syncFromReference(ref);
      return;
    }

    // Defend against a registry snapshot that lost its primary marker (rare —
    // shouldn't happen, but the partial unique index on isPrimary means we'd
    // hit a constraint violation if we tried to insert N runners-up with no
    // primary). Mark the first entry as primary if none is flagged.
    const hasPrimary = snapshot.some((entry) => entry.isPrimary);
    const fresh = snapshot.map((entry, index) => {
      const candidate = this.buildCandidate({
        ref,
        modelId: entry.model.id,
        model: entry.model,
        score: entry.confidence,
        isPrimary: hasPrimary ? entry.isPrimary : index === 0,
      });
      candidate.weight = entry.weight;
      return candidate;
    });

    const saved = await this.candidateRepository.repo.save(fresh);
    ref.candidates = saved;
    ref.ambiguousResolution = saved.length > 1;
    registry?.syncFromReference(ref);
  }

  private async loadModels(
    productIds: string[],
  ): Promise<Map<string, ProductModel>> {
    if (productIds.length === 0) return new Map();
    const models = await this.productModelRepository.repo.find({
      where: { id: In(productIds) },
      relations: [
        nameOf<ProductModel>("brand"),
        nameOf<ProductModel>("productCategory"),
      ],
    });
    return new Map(models.map((model) => [model.id, model]));
  }

  private buildCandidate(input: {
    ref: ProductReference;
    modelId: string;
    model: { id: string };
    score: number;
    isPrimary: boolean;
  }): ProductReferenceCandidate {
    const candidate = new ProductReferenceCandidate();
    candidate.reference = input.ref;
    candidate.model = input.model as ProductReferenceCandidate["model"];
    candidate.confidence = input.score;
    candidate.weight = 1;
    candidate.isPrimary = input.isPrimary;
    return candidate;
  }

  /**
   * Softmax over the candidate set, in place. Single-candidate sets get
   * weight = 1.0 trivially. TAU is tunable; lower = sharper.
   */
  private assignSoftmaxWeights(candidates: ProductReferenceCandidate[]): void {
    if (candidates.length <= 1) {
      candidates.forEach((c) => (c.weight = 1));
      return;
    }
    const expScores = candidates.map((c) =>
      Math.exp(c.confidence / SOFTMAX_TAU),
    );
    const denom = expScores.reduce((sum, v) => sum + v, 0);
    candidates.forEach((c, i) => {
      c.weight = denom > 0 ? expScores[i] / denom : 1 / candidates.length;
    });
  }

  private async deleteExistingCandidates(ref: ProductReference): Promise<void> {
    if (isEmpty(ref.candidates) && !ref.id) {
      return;
    }
    await this.candidateRepository.repo.delete({ reference: { id: ref.id } });
    ref.candidates = [];
  }
}
