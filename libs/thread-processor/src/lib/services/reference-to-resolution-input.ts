import type {
  ProductReference,
  ProductResolutionInput,
  StructuredSpec,
} from "@ebike-backend/database";

const CONTENT_QUALITY_RANK: Record<"high" | "medium" | "low", number> = {
  high: 2,
  medium: 1,
  low: 0,
};

/**
 * A reference is eligible for product resolution unless its (non-null) category
 * is disabled — a disabled-category reference waits for Resolution Backfill to
 * pick it up once the category is enabled. Requires `productCategory` (with
 * `extractionEnabled`) to be loaded.
 */
export function isCategoryResolvable(reference: ProductReference): boolean {
  return (
    !reference.productCategory ||
    reference.productCategory.extractionEnabled === true
  );
}

/** Normalised brand for the same-product sanity gate. */
function normalizeBrand(brand: string | undefined): string {
  return (brand ?? "").trim().toLowerCase();
}

/**
 * Pool the identifying evidence of every member of a `productLinkId` group into
 * a single resolution input — so the one resolution run per group benefits from
 * all mentions. Unions `specs` (deduped by spec name; the `base`/primary value
 * wins on conflict), `modelClues`, and `variantClues`, and fills the most
 * complete `model` / `displayName` / `referenceModel` and the strongest
 * `contentQuality`.
 *
 * Members whose brand contradicts the primary's are excluded — a guard against
 * an LLM mislabel merging two different products under one group (model spelling
 * is intentionally not gated, since the group is meant to bridge those).
 */
export function pooledGroupInput(
  members: ProductReference[],
  base: ProductResolutionInput,
): ProductResolutionInput {
  const baseBrand = normalizeBrand(base.brand);
  const specsByName = new Map<string, StructuredSpec>();
  for (const spec of base.specs ?? []) {
    specsByName.set(spec.name.toLowerCase(), spec);
  }
  const modelClues = new Set(base.modelClues ?? []);
  const variantClues = new Set(base.variantClues ?? []);
  let model = base.model;
  let displayName = base.displayName;
  let referenceModel = base.referenceModel;
  let contentQuality = base.contentQuality;

  for (const member of members) {
    const identification = member.context?.identification;
    if (!identification) continue;
    // Brand-mismatch guard against mislabelled groups.
    if (baseBrand && identification.brand) {
      if (normalizeBrand(identification.brand) !== baseBrand) continue;
    }
    for (const spec of identification.specs ?? []) {
      const key = spec.name.toLowerCase();
      if (!specsByName.has(key)) specsByName.set(key, spec);
    }
    for (const clue of identification.modelClues ?? []) modelClues.add(clue);
    for (const clue of identification.variantClues ?? [])
      variantClues.add(clue);
    if (!model && identification.model) model = identification.model;
    if (
      (identification.displayName?.length ?? 0) > (displayName?.length ?? 0)
    ) {
      displayName = identification.displayName;
    }
    if (!referenceModel && identification.referenceModel) {
      referenceModel = identification.referenceModel;
    }
    const memberQuality = identification.contentQuality;
    if (
      memberQuality &&
      CONTENT_QUALITY_RANK[memberQuality] >
        (contentQuality ? CONTENT_QUALITY_RANK[contentQuality] : -1)
    ) {
      contentQuality = memberQuality;
    }
  }

  return {
    ...base,
    specs: specsByName.size > 0 ? [...specsByName.values()] : base.specs,
    modelClues: modelClues.size > 0 ? [...modelClues] : base.modelClues,
    variantClues: variantClues.size > 0 ? [...variantClues] : base.variantClues,
    model: model ?? base.model,
    displayName,
    referenceModel,
    contentQuality,
  };
}

/**
 * Build a `ProductResolutionInput` from a `ProductReference`'s identification snapshot.
 *
 * `category.id` is populated from `reference.productCategory?.id` when the
 * upstream pre-resolved a catalog category. `category.name` falls back to the
 * verbatim `categoryHint` when identification didn't emit a `categories[]`.
 *
 * Spec enrichment lives in `ResolutionInputEnricher`; this helper is for
 * callsites that need a one-shot conversion without the ancestry-walk
 * (Resolution Backfill, legacy ProductReferenceResolutionService, post-extraction
 * re-resolution that overrides specs from `ref.specs`).
 */
export function referenceToResolutionInput(
  reference: ProductReference,
): ProductResolutionInput {
  const identification = reference.context.identification;
  const categoryName =
    identification.categories?.[0] ?? identification.categoryHint;
  const category = categoryName
    ? { id: reference.productCategory?.id, name: categoryName }
    : undefined;

  return {
    brand: identification.brand,
    model: identification.model,
    displayName: identification.displayName,
    categoryHint: identification.categoryHint,
    category,
    specs: identification.specs,
    referenceModel: identification.referenceModel,
    modelClues: identification.modelClues,
    variantClues: identification.variantClues,
    searchBefore: identification.searchBefore,
    contentQuality: identification.contentQuality,
  };
}
