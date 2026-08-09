import { Injectable } from "@nestjs/common";
import { ProductModel, ProductModelRepository } from "@ebike-backend/database";
import { SpecComparisonService } from "@ebike-backend/product";
import { InputNormalizationService } from "../matching/input-normalization.service";
import {
  computeEffectiveMatchSpecs,
  pickPrimarySpecs,
} from "../matching/effective-match-specs";
import {
  deriveReferenceRelation,
  type ReferenceRelation,
} from "../matching/derive-reference-relation";
import type { ResolutionContext } from "../models/resolution-context";
import type { ProductResolutionInput } from "../models/resolution-input";

/**
 * Outcome of reference-product resolution. Three branches:
 *
 *  - `resolved`              — `input.referenceProductId` set + classifies
 *                              `'same'`. Orchestrator returns the reference
 *                              entity immediately with `confidence=100`.
 *  - `reference_variant_search` — `'variant'` classification. Context is
 *                              populated with reference fields; orchestrator
 *                              continues with a normal search whose recall is
 *                              seeded by the reference SKU.
 *  - `null` (no reference)   — `input.referenceProductId` unset OR the entity
 *                              fetch returned null. Orchestrator falls through
 *                              to stage 2 (brand/category resolution) and a
 *                              full unanchored search.
 */
export type ReferenceResult =
  | {
      kind: "resolved";
      product: ProductModel;
      confidence: number;
      reason: string;
    }
  | { kind: "reference_variant_search"; product: ProductModel };

/**
 * Stage 1 — reference-product routing.
 *
 * When `input.referenceProductId` is set:
 *  1. Load the entity via `findByIdForPipeline` (one DB hit; brand + category
 *     + aliases come along on the same query — the lib never re-fetches).
 *  2. Classify `same` / `variant` via `deriveReferenceRelation` using the
 *     reference's category match config.
 *  3. For both `same` and `variant`, populate `ctx.referenceProduct`,
 *     `ctx.brand`, and `ctx.category` from the loaded entity (similarity=1.0).
 *     Downstream stages read one canonical shape regardless of source.
 *  4. For `variant`, also write `ctx.effectiveMatchSpecs` (reference primary
 *     specs ∩ input specs overlay) so the Filter stage can drop candidates
 *     that contradict the inherited dimensions.
 */
@Injectable()
export class ReferenceProductResolver {
  constructor(
    private readonly productModelRepository: ProductModelRepository,
    private readonly specComparison: SpecComparisonService,
    private readonly inputNormalization: InputNormalizationService,
  ) {}

  async resolve(context: ResolutionContext): Promise<ReferenceResult | null> {
    const referenceProductId = context.input.referenceProductId;
    if (!referenceProductId) return null;

    let referenceProduct: ProductModel | null = null;
    try {
      referenceProduct =
        await this.productModelRepository.findByIdForPipeline(
          referenceProductId,
        );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      context.errors.push({
        phase: "reference_product",
        message,
        timestamp: new Date().toISOString(),
      });
      return null;
    }

    if (!referenceProduct) {
      context.errors.push({
        phase: "reference_product",
        message: `referenceProductId ${referenceProductId} did not resolve to a catalog product`,
        timestamp: new Date().toISOString(),
      });
      return null;
    }

    const matchConfig = this.inputNormalization.getCategoryConfig(
      referenceProduct.productCategory ?? undefined,
    );

    // Populate ctx with reference-derived brand/category/snapshot regardless
    // of the relation. Downstream stages skip Stage 2 lookups when these are
    // already set.
    populateReferenceFields(
      context,
      referenceProduct,
      matchConfig.primarySpecs,
    );

    const relation: ReferenceRelation = deriveReferenceRelation(
      context.input,
      referenceProduct,
      matchConfig,
      this.specComparison,
    );

    if (relation === "same") {
      return {
        kind: "resolved",
        product: referenceProduct,
        confidence: 100,
        reason: "reference_same",
      };
    }

    if (relation === "variant") {
      // Seed effectiveMatchSpecs from the reference (inherited primary specs)
      // overlaid by the input's spec evidence. Filter consumes this to drop
      // candidates that contradict inherited dimensions.
      context.effectiveMatchSpecs = computeEffectiveMatchSpecs(
        referenceProduct.specs ?? undefined,
        context.input.specs,
        matchConfig.primarySpecs,
      );
      // Seed `reference_model` and category-hint clues onto the variant input
      // shape used by recall strategies via buildModelVariants. We don't mutate
      // `context.input` (frozen); buildModelVariants already pulls referenceModel
      // and modelClues off the input — and the caller is expected to set
      // input.referenceModel = referenceProduct.model when constructing the
      // variant search at the boundary. This stage doesn't need to mutate input.
      return { kind: "reference_variant_search", product: referenceProduct };
    }

    // relation === 'none' is unreachable when referenceProductId is set
    // (deriveReferenceRelation only returns 'none' when the id is unset).
    return null;
  }
}

function populateReferenceFields(
  context: ResolutionContext,
  referenceProduct: ProductModel,
  primarySpecs: string[] | undefined,
): void {
  const brand = referenceProduct.brand;
  if (brand) {
    context.brand = {
      id: brand.id,
      name: brand.name,
      similarity: 1.0,
    };
  }

  const category = referenceProduct.productCategory;
  if (category) {
    context.category = {
      id: category.id,
      name: category.name,
      similarity: 1.0,
    };
  }

  context.referenceProduct = {
    productId: referenceProduct.id,
    brand: brand?.name,
    model: referenceProduct.model ?? undefined,
    productCategory: category
      ? { id: category.id, name: category.name, slug: category.slug }
      : undefined,
    specs: pickPrimarySpecs(referenceProduct.specs, primarySpecs),
  };
}

/**
 * Helper for callers that want to construct a variant-search `ProductResolutionInput`
 * from the original input + the resolved reference entity. Mirrors the legacy
 * `buildAnchoredVariantInput` from subtree-processor — produces a derived input
 * that recall strategies consume.
 *
 * Currently exported alongside the resolver so Stage 7's cutover can use it.
 */
export function buildReferenceVariantInput(
  enrichedInput: ProductResolutionInput,
  referenceProduct: ProductModel,
): ProductResolutionInput {
  const brand = referenceProduct.brand?.name ?? enrichedInput.brand ?? "";
  const modelClues = enrichedInput.modelClues ?? [];
  return {
    ...enrichedInput,
    brand,
    // The comment didn't necessarily name a model — `modelClues` capture any
    // tokens it did mention. When neither the comment's own model nor a model
    // clue is present, leave model empty so recall keys off referenceProductId
    // + clues, not the reference itself.
    model: enrichedInput.model || modelClues[0] || "",
    referenceModel: referenceProduct.model ?? enrichedInput.referenceModel,
    displayName:
      `${referenceProduct.displayName ?? ""} ${modelClues.join(" ")}`.trim(),
    categoryHint:
      referenceProduct.productCategory?.name ?? enrichedInput.categoryHint,
  };
}
