import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  ProductCategory,
  ProductResolutionInput,
  StructuredSpec,
} from "@ebike-backend/database";
import {
  CategoryCacheService,
  CategoryNameMatcherService,
} from "@ebike-backend/product";
import { ThreadContext } from "../models/thread-context";
import {
  DiscoveredProduct,
  EnrichedDiscoveredProduct,
} from "../models/discovered-product.model";
import { resolveRegistryKey } from "../models/product-registry.model";

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Turns raw `product_discovery` output into resolvable distinct products:
 * two-pass category match (enabled preferred, else any catalog category →
 * deferred), fuzzy registry key, `productLinkId` mint/inherit, spec whitelist
 * filter, and the `ProductResolutionInput` the distinct-product resolver runs.
 *
 * Mirrors the identification-snapshot building that used to live inline in
 * `createReferencesFromIdentification`, but product-centric (one unit per
 * distinct product) rather than per comment.
 */
@Injectable()
export class DiscoveredProductEnricher {
  constructor(
    private readonly categoryCacheService: CategoryCacheService,
    private readonly categoryNameMatcher: CategoryNameMatcherService,
  ) {}

  /**
   * @param searchBefore Lower bound for time-bounded web search — the earliest
   *   PLAN-comment timestamp in the batch discovery drew from. A distinct
   *   product's first occurrence cannot precede it, so it is a sound bound for
   *   the resolve-time search (the persisted per-ref `searchBefore` is set
   *   per-mention later by the reference factory). Undefined leaves search
   *   unbounded.
   */
  async enrich(
    products: DiscoveredProduct[],
    context: ThreadContext,
    validSpecNames: Set<string>,
    searchBefore?: Date,
  ): Promise<EnrichedDiscoveredProduct[]> {
    const enabledCategories =
      await this.categoryCacheService.getExtractionEnabledCategories();
    const allCategories = await this.categoryCacheService.getAllCategories();

    // Per-batch linkLabel ("A","B",…) → resolved productLinkId. All mentions of
    // one distinct product share a label → share an id. A registry hit lets a
    // label inherit an existing cross-subtree group id.
    const linkLabelToUuid = new Map<string, string>();
    // Reverse guard: productLinkId → the label that claimed it THIS batch. The
    // fuzzy registry key (suffix/substring) can route two genuinely-distinct
    // labels to one registry entry; without this, both would inherit the same
    // group id and silently merge. A registry id already claimed by a different
    // label in this batch is NOT inherited — a fresh id is minted, leaving
    // cross-subtree grouping to `backfillLinkGroups` (which uses real
    // resolution evidence, not a fuzzy string match).
    const uuidToLinkLabel = new Map<string, string>();

    return products.map((product) =>
      this.enrichOne(
        product,
        context,
        validSpecNames,
        enabledCategories,
        allCategories,
        linkLabelToUuid,
        uuidToLinkLabel,
        searchBefore,
      ),
    );
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private enrichOne(
    product: DiscoveredProduct,
    context: ThreadContext,
    validSpecNames: Set<string>,
    enabledCategories: ProductCategory[],
    allCategories: ProductCategory[],
    linkLabelToUuid: Map<string, string>,
    uuidToLinkLabel: Map<string, string>,
    searchBefore: Date | undefined,
  ): EnrichedDiscoveredProduct {
    const productCategory = this.matchCategory(
      product.categoryHint,
      enabledCategories,
      allCategories,
    );

    const registryKey = resolveRegistryKey(
      product.brand,
      product.model,
      context.productRegistry,
    );

    const filteredSpecs = this.filterSpecs(product.specs, validSpecNames);

    const productLinkId = this.resolveProductLinkId(
      product.linkLabel,
      registryKey,
      context,
      linkLabelToUuid,
      uuidToLinkLabel,
    );

    const resolutionInput = this.buildResolutionInput(
      product,
      productCategory,
      filteredSpecs,
      searchBefore,
    );

    return {
      discovered: product,
      distinctKey: product.linkLabel,
      productLinkId,
      registryKey,
      productCategory,
      filteredSpecs,
      resolutionInput,
    };
  }

  /** Two-pass category match: enabled categories first (resolves immediately),
   *  then any catalog category (deferred but category-linked). */
  private matchCategory(
    categoryHint: string | undefined,
    enabledCategories: ProductCategory[],
    allCategories: ProductCategory[],
  ): ProductCategory | undefined {
    if (!categoryHint) return undefined;
    const enabledMatch = this.categoryNameMatcher.matchByName(
      categoryHint,
      enabledCategories,
    );
    if (enabledMatch) return enabledMatch;
    return this.categoryNameMatcher.matchByName(categoryHint, allCategories);
  }

  /** Hard-enforce valid spec names: drop any spec not on the category whitelist. */
  private filterSpecs(
    specs: StructuredSpec[] | undefined,
    validSpecNames: Set<string>,
  ): StructuredSpec[] {
    if (!specs?.length) return [];
    if (validSpecNames.size === 0) return specs;
    return specs.filter((spec) => validSpecNames.has(spec.name));
  }

  /** Resolve a distinct product's same-product group id. The per-batch
   *  `linkLabel` is the authoritative distinctness signal (the discovery LLM's
   *  own judgment); a registry hit lets a label inherit an existing cross-
   *  subtree group id, EXCEPT when the fuzzy registry key has already routed a
   *  DIFFERENT label in this batch to that same id — inheriting then would
   *  silently merge two genuinely-distinct products. In that case a fresh id is
   *  minted and cross-subtree grouping is left to `backfillLinkGroups`. */
  private resolveProductLinkId(
    linkLabel: string,
    registryKey: string,
    context: ThreadContext,
    linkLabelToUuid: Map<string, string>,
    uuidToLinkLabel: Map<string, string>,
  ): string {
    // Same label seen earlier this batch → reuse (idempotent).
    const claimed = linkLabel ? linkLabelToUuid.get(linkLabel) : undefined;
    if (claimed) return claimed;

    const registryGroupId =
      context.productRegistry.get(registryKey)?.productLinkId;
    const claimedByOther = registryGroupId
      ? uuidToLinkLabel.get(registryGroupId)
      : undefined;
    // Inherit the registry group id only if no different in-batch label already
    // owns it (fuzzy-collision guard).
    const resolved =
      registryGroupId && (!claimedByOther || claimedByOther === linkLabel)
        ? registryGroupId
        : randomUUID();

    if (linkLabel) {
      linkLabelToUuid.set(linkLabel, resolved);
      uuidToLinkLabel.set(resolved, linkLabel);
    }
    return resolved;
  }

  private buildResolutionInput(
    product: DiscoveredProduct,
    productCategory: ProductCategory | undefined,
    filteredSpecs: StructuredSpec[],
    searchBefore: Date | undefined,
  ): ProductResolutionInput {
    const categoryName = productCategory?.name ?? product.categoryHint;
    return {
      brand: product.brand,
      model: product.model,
      displayName: `${product.brand} ${product.model}`.trim(),
      categoryHint: product.categoryHint,
      category: categoryName
        ? { id: productCategory?.id, name: categoryName }
        : undefined,
      specs: filteredSpecs.length > 0 ? filteredSpecs : undefined,
      referenceModel: product.referenceModel,
      modelClues: product.modelClues,
      variantClues: product.variantClues,
      searchBefore,
      contentQuality: product.contentQuality,
    };
  }
}
