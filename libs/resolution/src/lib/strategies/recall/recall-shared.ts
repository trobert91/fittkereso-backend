import type {
  EvaluatedProduct,
  ProductModel,
  WithSimilarity,
} from "@ebike-backend/database";
import type { ResolutionContext } from "../../models/resolution-context";
import type { SlimCandidate } from "../../models/slim-types";
import { buildModelVariants } from "../../matching/build-model-variants";

export const MAX_MODEL_VARIANTS_DEFAULT = 20;

/**
 * Build the base model-variant seeds for a resolution, memoized on the context.
 *
 * `buildModelVariants(context.input, ...)` is deterministic for a given input,
 * and both the fuzzy and embedding recall strategies need the same seeds in the
 * same pass. Computing it once and caching on the context avoids the duplicate
 * string work. Callers that need extra seeds (e.g. fuzzy's reference_model
 * variant) append to a copy — the cached array is never mutated.
 */
export function getBaseModelVariants(
  context: ResolutionContext,
  maxModelVariants: number,
): ReturnType<typeof buildModelVariants> {
  if (context.baseModelVariants) return context.baseModelVariants;
  const variants = buildModelVariants(context.input, {
    brandName: context.brand?.name,
    maxModelVariants,
  });
  context.baseModelVariants = variants;
  return variants;
}

/**
 * Record variant seeds on the context (for traces), skipping ones already
 * present. Shared by both recall strategies.
 */
export function recordVariants(
  context: ResolutionContext,
  variants: ReturnType<typeof buildModelVariants>,
): void {
  for (const variant of variants) {
    if (
      !context.modelVariants.some(
        (existing) => existing.model === variant.model,
      )
    ) {
      context.modelVariants.push(variant);
    }
  }
}

/**
 * Dedupe per-variant search hits by productId, keeping the highest-similarity
 * hit, and convert to `SlimCandidate[]`. Shared by the fuzzy and embedding
 * recall strategies, which differ only in their hit type, their similarity
 * accessor, and their slim converter.
 *
 * The returned candidates carry `matchScore: undefined` — recall does not score;
 * Stage 5 (Scoring) assigns the matcher's 0–100 score.
 */
export function dedupeBySimilarity<THit>(
  hits: THit[],
  getProductId: (hit: THit) => string,
  getSimilarity: (hit: THit) => number,
  toSlim: (hit: THit) => SlimCandidate,
): SlimCandidate[] {
  const merged = new Map<
    string,
    { candidate: SlimCandidate; similarity: number }
  >();
  for (const hit of hits) {
    const productId = getProductId(hit);
    const similarity = getSimilarity(hit);
    const existing = merged.get(productId);
    if (!existing || similarity > existing.similarity) {
      merged.set(productId, { candidate: toSlim(hit), similarity });
    }
  }
  return Array.from(merged.values()).map((entry) => entry.candidate);
}

export function fuzzyHitToSlim(
  hit: WithSimilarity<ProductModel>,
): SlimCandidate {
  return {
    productId: hit.entity.id,
    brand: hit.entity.brand?.name,
    brandId: hit.entity.brand?.id,
    model: hit.entity.model,
    displayName: hit.entity.displayName,
    productCategory: hit.entity.productCategory
      ? {
          id: hit.entity.productCategory.id,
          name: hit.entity.productCategory.name,
          slug: hit.entity.productCategory.slug,
        }
      : undefined,
    specs: hit.entity.specs,
    aliases: hit.entity.aliases?.map((alias) => alias.alias),
    source: "fuzzy",
  };
}

export function embeddingHitToSlim(hit: EvaluatedProduct): SlimCandidate {
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
