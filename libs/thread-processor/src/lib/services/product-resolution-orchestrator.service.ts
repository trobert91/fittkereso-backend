import { Injectable } from "@nestjs/common";
import {
  getPrimaryCandidate,
  ProductReference,
  ProductReferenceRepository,
  Thread,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { ResolutionResultApplierService } from "@ebike-backend/resolution";
import { ProductRegistryService } from "./product-registry.service";
import { isCategoryResolvable } from "./reference-to-resolution-input";
import { Subtree, ThreadContext } from "../models";

/**
 * Cross-batch `productLinkId` backfill, run once after all subtrees are
 * processed. A product first mentioned in an early subtree may resolve only
 * later in the same thread (a higher-confidence member triggers web search);
 * this propagates the resolved candidate set to the group's still-unresolved
 * members so the review phase materialises them immediately — no extra search.
 *
 * Within-batch resolution (discover → resolve → identify, refs born resolved)
 * lives in pass 1 (`DistinctProductResolver` + `WideIdentificationPassService`),
 * so the old per-comment resolver — pooling, primary-election, the fixpoint
 * loop, registry-key locks — is gone. This service is now just the end-of-thread
 * group sweep, sharing the candidate-copy primitive with the scheduled
 * Resolution Backfill.
 */
@Injectable()
export class ProductResolutionOrchestratorService {
  private readonly logger = new CustomLogger(
    ProductResolutionOrchestratorService.name,
  );

  constructor(
    private readonly productRegistry: ProductRegistryService,
    private readonly resolutionApplier: ResolutionResultApplierService,
    private readonly productReferenceRepository: ProductReferenceRepository,
  ) {}

  async backfillLinkGroups(
    allSubtrees: Subtree[],
    thread: Thread,
    context: ThreadContext,
  ): Promise<void> {
    // Collect every distinct ref across the thread, grouped by productLinkId.
    const groups = new Map<string, ProductReference[]>();
    const seen = new Set<string>();
    for (const subtree of allSubtrees) {
      for (const node of subtree.planNodes) {
        for (const ref of node.comment.productReferences ?? []) {
          if (!ref.productLinkId || seen.has(ref.id)) continue;
          seen.add(ref.id);
          const group = groups.get(ref.productLinkId);
          if (group) group.push(ref);
          else groups.set(ref.productLinkId, [ref]);
        }
      }
    }

    const registryUpdater = this.productRegistry.createUpdaterFor(context);
    const toSave: ProductReference[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const resolved = group.filter((ref) => (ref.candidates?.length ?? 0) > 0);
      if (resolved.length === 0) continue;

      // Source = highest-confidence resolved member.
      const source = [...resolved].sort(
        (a, b) =>
          (getPrimaryCandidate(b)?.confidence ?? 0) -
          (getPrimaryCandidate(a)?.confidence ?? 0),
      )[0];
      const sourceModelId = getPrimaryCandidate(source)?.model?.id;
      if (
        resolved.some(
          (ref) => getPrimaryCandidate(ref)?.model?.id !== sourceModelId,
        )
      ) {
        this.logger.warn(
          "productLinkId group resolved to multiple products — propagating the highest-confidence one",
          { threadId: thread.id, productLinkId: source.productLinkId },
        );
      }

      const snapshot = (source.candidates ?? []).map((c) => ({
        model: c.model,
        weight: c.weight,
        confidence: c.confidence,
        isPrimary: c.isPrimary,
      }));
      for (const ref of group) {
        if ((ref.candidates?.length ?? 0) > 0) continue;
        // Leave disabled-category members for the scheduled Resolution Backfill
        // (once their category is enabled) — propagating here would resolve a ref
        // the pipeline intentionally holds back.
        if (!isCategoryResolvable(ref)) continue;
        if (!sameProductBrand(source, ref)) continue;
        await this.resolutionApplier.copyCandidateSet(
          ref,
          snapshot,
          registryUpdater,
        );
        ref.resolutionFinished = true;
        ref.resolutionLastAttemptedAt = new Date();
        toSave.push(ref);
      }
    }

    if (toSave.length > 0) {
      await this.productReferenceRepository.saveAll(toSave);
    }
  }
}

/** Same-product brand sanity gate: a group only inherits a candidate set when
 *  brands agree (or one is blank) — guards against an LLM mislabel merging two
 *  different products under one productLinkId. */
function sameProductBrand(a: ProductReference, b: ProductReference): boolean {
  const brandA = (a.context?.identification?.brand ?? "").trim().toLowerCase();
  const brandB = (b.context?.identification?.brand ?? "").trim().toLowerCase();
  return brandA === "" || brandB === "" || brandA === brandB;
}
