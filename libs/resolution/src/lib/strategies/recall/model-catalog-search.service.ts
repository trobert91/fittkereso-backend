import { Injectable } from "@nestjs/common";
import {
  ProductEmbeddingMatchService,
  ProductFuzzySearchService,
  type CandidateSearchInput,
} from "@ebike-backend/product";
import type { ResolutionContext } from "../../models/resolution-context";
import type { SlimCandidate } from "../../models/slim-types";

export interface ModelCatalogSearchArgs {
  modelString: string;
  context: ResolutionContext;
  useEmbedding: boolean;
}

export interface ModelCatalogSearchResult {
  candidates: SlimCandidate[];
  source: "fuzzy" | "embedding" | "none";
}

/**
 * Per-model catalog search.
 *
 * Runs one fuzzy search for a single concrete model string against the catalog;
 * if fuzzy returns no hits and `useEmbedding` is true, falls back to one
 * embedding search. Returns `SlimCandidate[]` tagged with the strategy that
 * produced them.
 *
 * Used by `CatalogResolver` to re-search the catalog for each SKU extracted
 * from SERP records, so that web-research recall benefits from the same
 * embedding fallback as primary recall. The primary `FuzzyRecallStrategy` /
 * `EmbeddingRecallStrategy` fan out per generated *variant*; this service is
 * the per-model leaf — no variant expansion, since extracted SKUs are already
 * concrete model numbers.
 */
@Injectable()
export class ModelCatalogSearchService {
  constructor(
    private readonly fuzzySearch: ProductFuzzySearchService,
    private readonly embeddingMatch: ProductEmbeddingMatchService,
  ) {}

  async search({
    modelString,
    context,
    useEmbedding,
  }: ModelCatalogSearchArgs): Promise<ModelCatalogSearchResult> {
    const trimmed = modelString.trim();
    if (trimmed.length === 0) return { candidates: [], source: "none" };

    const categoryIds = context.category ? [context.category.id] : undefined;
    const brandIds = context.brand ? [context.brand.id] : undefined;
    const candidateBrand = context.brand
      ? {
          id: context.brand.id,
          name: context.brand.name,
          similarity: context.brand.similarity,
        }
      : undefined;

    const fuzzyInput: CandidateSearchInput = {
      input: { ...context.input, model: trimmed },
      brand: candidateBrand,
    };
    const fuzzyHits = await this.fuzzySearch.search(fuzzyInput, categoryIds);
    if (fuzzyHits.length > 0) {
      return {
        candidates: fuzzyHits.map((hit) => fuzzyToSlim(hit)),
        source: "fuzzy",
      };
    }

    if (!useEmbedding) return { candidates: [], source: "none" };

    const embeddingHits = await this.embeddingMatch.findMatches(
      { ...context.input, model: trimmed },
      categoryIds,
      brandIds,
    );
    if (embeddingHits.length === 0) return { candidates: [], source: "none" };
    return {
      candidates: embeddingHits.map((hit) => embeddingToSlim(hit)),
      source: "embedding",
    };
  }
}

function fuzzyToSlim(
  hit: Awaited<ReturnType<ProductFuzzySearchService["search"]>>[number],
): SlimCandidate {
  const entity = hit.entity;
  return {
    productId: entity.id,
    brand: entity.brand?.name,
    brandId: entity.brand?.id,
    model: entity.model,
    displayName: entity.displayName,
    productCategory: entity.productCategory
      ? {
          id: entity.productCategory.id,
          name: entity.productCategory.name,
          slug: entity.productCategory.slug,
        }
      : undefined,
    specs: entity.specs,
    aliases: entity.aliases?.map((alias) => alias.alias),
    source: "fuzzy",
  };
}

function embeddingToSlim(
  hit: Awaited<ReturnType<ProductEmbeddingMatchService["findMatches"]>>[number],
): SlimCandidate {
  return {
    productId: hit.id,
    brand: hit.brand,
    brandId: hit.brandId,
    model: hit.model,
    displayName: hit.displayName,
    productCategory: hit.category
      ? {
          id: hit.category.id,
          name: hit.category.name,
          slug: hit.category.slug,
        }
      : undefined,
    specs: hit.specs,
    aliases: hit.aliases,
    source: "embedding",
  };
}
