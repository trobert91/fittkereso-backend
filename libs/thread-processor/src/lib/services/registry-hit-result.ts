import type {
  ProductModel,
  ProductResolutionInput,
} from "@ebike-backend/database";
import {
  ResolutionContext,
  ResolutionResult,
  ResolutionStatus,
} from "@ebike-backend/resolution";

/**
 * Synthesize a v2 `ResolutionContext` for a registry-hit instant resolve. The
 * resolution lib never ran in this case — we build the context ourselves so the
 * persisted artifact has a consistent shape across all resolution paths.
 * Confidence is on the 0–100 scale.
 *
 * Shared by the per-reference orchestrator path (registry-cache hit) and the
 * distinct-product resolver (a discovered product already resolved in an earlier
 * subtree). Takes the resolution INPUT + the resolved model so both a
 * `ProductReference`-derived input and a `DiscoveredProduct`-derived input route
 * through the same builder.
 */
export function buildRegistryHitContext(
  input: ProductResolutionInput,
  resolvedModel: ProductModel | undefined,
  candidateSet?: ReadonlyArray<{
    model: ProductModel;
    confidence: number;
    isPrimary: boolean;
  }>,
): ResolutionContext {
  // When the registry entry carries a full (possibly ambiguous) candidate set,
  // surface ALL of them as selected candidates so the applier reproduces the
  // full multi-candidate set + ambiguity — primary first. Otherwise fall back to
  // the single resolved model.
  const orderedCandidates =
    candidateSet && candidateSet.length > 0
      ? [...candidateSet].sort(
          (a, b) => Number(b.isPrimary) - Number(a.isPrimary),
        )
      : undefined;

  const selectedCandidates = orderedCandidates
    ? orderedCandidates
        .filter((candidate) => candidate.model?.id)
        .map((candidate) => ({
          candidateId: candidate.model.id,
          confidence: candidate.confidence,
          reason: "registry_hit",
        }))
    : resolvedModel?.id
      ? [
          {
            candidateId: resolvedModel.id,
            confidence: 100,
            reason: "registry_hit",
          },
        ]
      : [];

  return {
    input,
    options: { useEmbedding: false, webSearchEnabled: false, mode: "loose" },
    modelVariants: [],
    searchedKeywords: [],
    searchEvidence: [],
    candidates: [],
    strategiesRun: [],
    status: ResolutionStatus.RESOLVED,
    decision: {
      kind: "matcher_accept",
      confidence: selectedCandidates[0]?.confidence ?? 100,
      reason: "registry_hit",
      selectedCandidates,
      evidenceSummary: "thread-scoped product registry resolved this reference",
    },
    resolvedProduct: resolvedModel
      ? {
          id: resolvedModel.id,
          brand: resolvedModel.brand?.name,
          model: resolvedModel.model,
          displayName: resolvedModel.displayName,
          categoryId: resolvedModel.productCategory?.id,
          categoryName: resolvedModel.productCategory?.name,
          specs: [],
        }
      : undefined,
    totals: { durationMs: 0, cost: 0, llmCalls: 0, webSearchCalls: 0 },
    errors: [],
  };
}

/**
 * Build a synthetic `ResolutionResult` for a registry-hit instant resolve so it
 * can be routed through `ResolutionResultApplierService.apply()` alongside real
 * search results.
 */
export function buildRegistryHitResult(
  input: ProductResolutionInput,
  resolvedModel: ProductModel,
  candidateSet?: ReadonlyArray<{
    model: ProductModel;
    confidence: number;
    isPrimary: boolean;
  }>,
): ResolutionResult {
  return {
    resolvedModel,
    context: buildRegistryHitContext(input, resolvedModel, candidateSet),
    confidence: 100,
  };
}
