import { Injectable } from "@nestjs/common";
import type { ProductSpecs } from "@ebike-backend/database";
import { InputNormalizationService } from "../matching/input-normalization.service";
import { pickPrimarySpecs } from "../matching/effective-match-specs";
import { ModelCatalogSearchService } from "../strategies/recall/model-catalog-search.service";
import type { ResolutionContext } from "../models/resolution-context";
import type { SearchEvidence } from "../models/search-evidence";
import type { SlimCandidate } from "../models/slim-types";

export interface CatalogResolveResult {
  /** SKUs that resolved to a catalog product, as new SlimCandidates (source='web'). */
  addedCandidates: SlimCandidate[];
  /** SKUs the extractor surfaced that did NOT resolve to a catalog row. */
  webOnlyModels: string[];
}

/**
 * Catalog re-search for the SKUs the SERP-SKU extractor surfaced.
 *
 * For each unique model-number across `searchEvidence[*].modelNumbers`,
 * delegates to `ModelCatalogSearchService` (fuzzy first, embedding fallback
 * when `ctx.options.useEmbedding` is true and fuzzy returned nothing). Write
 * resolved products back into each record's `resolvedProducts` array (matched
 * by model-number).
 *
 * Returns new `SlimCandidate[]` (source `'web'`) for the recall pool plus the
 * list of SKUs that didn't resolve (recorded as `webOnlyModels` for traces).
 */
@Injectable()
export class CatalogResolver {
  constructor(
    private readonly modelCatalogSearch: ModelCatalogSearchService,
    private readonly inputNormalization: InputNormalizationService,
  ) {}

  async resolve(
    context: ResolutionContext,
    searchEvidence: SearchEvidence[],
  ): Promise<CatalogResolveResult> {
    const allModelNumbers = collectModelNumbers(searchEvidence);
    if (allModelNumbers.length === 0) {
      return { addedCandidates: [], webOnlyModels: [] };
    }

    const useEmbedding = context.options.useEmbedding ?? false;

    const resolvedByModel = new Map<string, SlimCandidate>();
    const unresolved: string[] = [];

    for (const modelNumber of allModelNumbers) {
      try {
        const { candidates } = await this.modelCatalogSearch.search({
          modelString: modelNumber,
          context,
          useEmbedding,
        });
        const best = candidates[0];
        if (best) {
          resolvedByModel.set(modelNumber, best);
        } else {
          unresolved.push(modelNumber);
        }
      } catch {
        unresolved.push(modelNumber);
      }
    }

    for (const record of searchEvidence) {
      record.resolvedProducts = [];
      for (const modelNumber of record.modelNumbers) {
        const resolved = resolvedByModel.get(modelNumber);
        if (!resolved) continue;
        const specs = this.subsetSpecsToPrimary(resolved);
        if (
          record.resolvedProducts.some(
            (entry) => entry.productId === resolved.productId,
          )
        )
          continue;
        record.resolvedProducts.push({
          brand: resolved.brand ?? context.input.brand ?? "",
          model: resolved.model ?? modelNumber,
          productId: resolved.productId,
          specs,
        });
      }
    }

    const addedCandidates: SlimCandidate[] = [];
    const seenIds = new Set<string>();
    for (const resolved of resolvedByModel.values()) {
      if (seenIds.has(resolved.productId)) continue;
      seenIds.add(resolved.productId);
      addedCandidates.push({ ...resolved, source: "web" });
    }

    return { addedCandidates, webOnlyModels: unresolved };
  }

  private subsetSpecsToPrimary(resolved: SlimCandidate): ProductSpecs {
    const matchConfig = this.inputNormalization.getCategoryConfig(
      resolved.productCategory ?? undefined,
    );
    return pickPrimarySpecs(resolved.specs, matchConfig.primarySpecs);
  }
}

function collectModelNumbers(searchEvidence: SearchEvidence[]): string[] {
  const set = new Set<string>();
  for (const record of searchEvidence) {
    for (const modelNumber of record.modelNumbers) {
      if (modelNumber.length > 0) set.add(modelNumber);
    }
  }
  return Array.from(set);
}
