import { fuzzy } from "fast-fuzzy";
import { Injectable } from "@nestjs/common";
import {
  Depth,
  ExperienceType,
  getPrimaryModel as getPrimaryModelHelper,
  ProductModel,
  ProductReference,
  StructuredSpec,
  UserComment,
} from "@ebike-backend/database";
import type { ResolutionRegistryUpdater } from "@ebike-backend/resolution";
import { ProductSpecContextService } from "@ebike-backend/product";
import {
  ProductRegistryEntry,
  RegistryOptions,
  buildRegistryKey,
} from "../models/product-registry.model";
import { Subtree } from "../models/subtree.model";
import { ThreadContext } from "../models/thread-context";
import { DEPTH_RANK } from "./registry-rank.constants";
import { RegistryCheatSheetRenderer } from "./registry-cheat-sheet-renderer.service";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RECENCY_PRIORITY: Record<ProductRegistryEntry["recency"], number> = {
  in_op: 3,
  latest: 2,
  recent: 1,
  earlier: 0,
};

const MAX_MENTIONED_AS = 5;

/**
 * Minimum fuzzy score (0–1) for an abbreviation to be considered a
 * redundant fragment of the product's brand/model/displayName.
 * Corresponds roughly to ≤1 edit per 6 characters via the Sellers algorithm.
 */
const REDUNDANCY_SCORE_THRESHOLD = 0.84;

/**
 * Matches deictic/contextual phrases that are meaningless outside the
 * original conversation context — "this one", "that monitor", "the MSI",
 * "my LG", "mine", etc. These should never appear in the cheat sheet.
 *
 * Pattern structure:
 *   ^(this|that|the|my|their|its|your|his|her|our)(\s+\w+){0,2}$
 * Also catches bare pronouns: "it", "mine", "one", "this", "that".
 */
const DEICTIC_PATTERN =
  /^(it|mine|one|this|that|these|those|the|my|their|its|your|his|her|our)(\s+\w+){0,2}$/i;

/** Returns true if the abbreviation is a deictic/generic phrase with no standalone value. */
function isDeicticAbbreviation(abbr: string): boolean {
  return DEICTIC_PATTERN.test(abbr.trim());
}

/**
 * Abbreviations that are too weak to uniquely identify a product and must not be
 * stored as aliases. Brand-only aliases ("LG") get multiple products resolved
 * against them; generic tech words ("OLED", "monitor") and pure numeric specs
 * ("240Hz", "39 inch") cannot disambiguate on their own.
 */
const GENERIC_WORD_BLOCKLIST = new Set([
  "monitor",
  "display",
  "screen",
  "panel",
  "device",
  "unit",
  "product",
  "gaming",
  "model",
  "version",
  "variant",
  "the",
  "one",
  "thing",
  "system",
]);

/** Matches pure numeric specs with a unit suffix, e.g. "240Hz", "39 inch", "1800R", "1440p". */
const NUMERIC_SPEC_PATTERN =
  /^\d+(?:\.\d+)?\s*(?:hz|hertz|inch|in|"|mm|cm|%|r|p|k)$/i;

/**
 * Returns true if the abbreviation is structurally too weak to identify the
 * resolved product — brand-only, generic tech/category word, pure numeric spec,
 * or too short to be distinctive.
 */
function isWeakAbbreviation(
  entry: ProductRegistryEntry,
  abbr: string,
): boolean {
  const trimmed = abbr.trim();
  if (trimmed.length < 3) return true;

  const lower = trimmed.toLowerCase();
  if (lower === entry.brand.trim().toLowerCase()) return true;
  if (GENERIC_WORD_BLOCKLIST.has(lower)) return true;
  if (NUMERIC_SPEC_PATTERN.test(lower)) return true;

  return false;
}

/** Strip everything except alphanumeric characters for model-name comparison. */
function stripNonAlphanumeric(s: string): string {
  return s.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Returns true if the abbreviation is already captured in the product's
 * brand, model, or display name. Uses fast-fuzzy's Sellers-algorithm
 * substring matching, which handles exact matches, punctuation/case
 * differences, and near-matches in a single score.
 */
function isRedundantAbbreviation(
  entry: ProductRegistryEntry,
  abbr: string,
): boolean {
  if (isDeicticAbbreviation(abbr)) return true;

  const haystack = `${entry.brand} ${entry.model} ${entry.displayName} ${entry.extractedName ?? ""}`;
  if (
    fuzzy(abbr, haystack, { ignoreCase: true }) >= REDUNDANCY_SCORE_THRESHOLD
  ) {
    return true;
  }

  // Check if the abbreviation is a model-name variant — either the model is a
  // near-substring of the abbreviation (e.g. "MPG-341CQPX-QD-OLED" contains
  // "mpg341cqpx") or vice versa (e.g. "34GS95QE" inside "34gs95qeb"). Both
  // directions are checked after stripping non-alphanumeric characters.
  const normalizedAbbr = stripNonAlphanumeric(abbr);
  const normalizedModel = stripNonAlphanumeric(entry.model);
  if (
    normalizedAbbr.length >= 3 &&
    normalizedModel.length >= 3 &&
    (fuzzy(normalizedModel, normalizedAbbr, { ignoreCase: true }) >=
      REDUNDANCY_SCORE_THRESHOLD ||
      fuzzy(normalizedAbbr, normalizedModel, { ignoreCase: true }) >=
        REDUNDANCY_SCORE_THRESHOLD)
  ) {
    return true;
  }

  // Also check with the brand prefix stripped. Catches abbreviations like
  // "MSI 341CQPX" or "LG 34GS95QE" where the model fragment alone is a
  // clear substring of the product name but the full string scores below
  // the threshold because the brand disrupts the window alignment.
  const abbrLower = abbr.toLowerCase();
  const brandLower = entry.brand.toLowerCase();
  if (abbrLower.startsWith(brandLower)) {
    const withoutBrand = abbrLower.slice(brandLower.length).trim();
    if (
      withoutBrand &&
      fuzzy(withoutBrand, haystack, { ignoreCase: true }) >=
        REDUNDANCY_SCORE_THRESHOLD
    ) {
      return true;
    }
  }

  return false;
}

/** Collect identification-sourced alias names from a single ref for the
 *  `mentionedAs` list. Pulls modelClues + variantClues (both are user-written
 *  tokens describing the product). Empty/whitespace strings are dropped. */
function collectAliasInputs(ref: ProductReference): string[] {
  return [
    ...(ref.context?.identification?.modelClues ?? []),
    ...(ref.context?.identification?.variantClues ?? []),
  ].filter((name) => typeof name === "string" && name.trim().length > 0);
}

/** Merge new alias names into an existing entry's mentionedAs list,
 *  deduplicating case-insensitively, filtering weak/redundant strings, and
 *  capping at MAX_MENTIONED_AS. */
function mergeMentionedAs(
  entry: ProductRegistryEntry,
  newNames: string[],
): void {
  if (newNames.length === 0) return;
  const existing = entry.mentionedAs ?? [];
  const existingSet = new Set(existing.map((a) => a.toLowerCase()));
  for (const name of newNames) {
    if (existing.length >= MAX_MENTIONED_AS) break;
    if (
      !existingSet.has(name.toLowerCase()) &&
      !isWeakAbbreviation(entry, name) &&
      !isRedundantAbbreviation(entry, name)
    ) {
      existing.push(name);
      existingSet.add(name.toLowerCase());
    }
  }
  entry.mentionedAs = existing.length > 0 ? existing : undefined;
}

/** Union `incoming` structured specs into `existing` (deduped by lowercase
 *  spec name, first value wins). Returns the merged array. */
function mergeStructuredSpecs(
  existing: StructuredSpec[] | undefined,
  incoming: StructuredSpec[],
): StructuredSpec[] {
  const merged = [...(existing ?? [])];
  const seen = new Set(merged.map((spec) => spec.name.toLowerCase()));
  for (const spec of incoming) {
    const key = spec.name.toLowerCase();
    if (!seen.has(key)) {
      merged.push(spec);
      seen.add(key);
    }
  }
  return merged;
}

@Injectable()
export class ProductRegistryService {
  constructor(
    private readonly productSpecContextService: ProductSpecContextService,
    private readonly cheatSheetRenderer: RegistryCheatSheetRenderer,
  ) {}

  private getPrimaryModel(ref: ProductReference): ProductModel | undefined {
    return getPrimaryModelHelper(ref);
  }

  /**
   * Snapshot the full candidate set off a reference for storage in the
   * registry entry. Returns undefined when the ref has no candidates so
   * downstream code can treat "no snapshot" as "fall back to primary only".
   */
  private snapshotCandidateSet(
    ref: ProductReference,
  ): ProductRegistryEntry["candidateSet"] | undefined {
    const candidates = ref.candidates ?? [];
    if (candidates.length === 0) return undefined;
    return candidates
      .filter((candidate) => candidate.model != null)
      .map((candidate) => ({
        model: candidate.model,
        weight: candidate.weight ?? 1,
        confidence: candidate.confidence ?? 0,
        isPrimary: candidate.isPrimary,
      }));
  }

  /**
   * Rebuild the in-memory product registry from a set of references loaded
   * from the database — used when reprocessing a thread so the registry
   * reflects the previously-persisted candidate sets before the new run begins.
   *
   * Phase 1 stores only the primary candidate per registry entry; Phase 2 will
   * extend the entry shape to carry the full candidate set so ambiguity
   * propagates through the registry.
   */
  loadFromReferences(refs: ProductReference[], context: ThreadContext): void {
    // Phase 1: equivalent to upsertFromReferences with isOpSubtree=false —
    // we don't know per-ref OP membership at rebuild time; the OP subtree
    // re-runs on the next pass and re-sets the OP markers.
    this.upsertFromReferences(refs, false, context);
  }

  /**
   * Bring the registry entry for a single reference into sync with its
   * just-written candidate set. Invoked by `ResolutionResultApplierService`
   * after every `apply` / `copyCandidateSet` so the registry's
   * `resolvedProduct` and `candidateSet` always reflect the persisted state.
   *
   * Owns ONLY the resolution projection — `resolvedProduct`, `displayName`,
   * `specs`, `category`, `candidateSet`. The mention projection
   * (`referenceCount`, `inOp`, `recency`, `maxDepth`, `mentionedAs`) stays
   * owned by the per-subtree upsert sweep in Phase 7, which runs once after
   * all refs in a subtree have been resolved + extracted.
   *
   * Idempotent: calling it twice with the same ref is a no-op the second time.
   * Safe to call from re-resolution paths — the new candidate set replaces the
   * old one regardless of whether the entry already existed.
   */
  /**
   * Build a `ResolutionRegistryUpdater` bound to the supplied `ThreadContext`
   * so the applier can call `syncFromReference(ref)` without knowing about
   * `ThreadContext`. Returned object holds the context by reference — pass a
   * fresh one per thread.
   */
  createUpdaterFor(context: ThreadContext): ResolutionRegistryUpdater {
    return {
      syncFromReference: (ref: ProductReference) => {
        this.syncFromReference(ref, context);
      },
    };
  }

  /**
   * Capture the same-product `productLinkId` onto the entry (first-write-wins so
   * the original group is preserved) and accumulate the reference's structured
   * identification specs (deduped by name, first value wins). Call on every
   * entry create/update so cross-subtree mentions inherit the group and pool
   * their evidence.
   */
  private applyLink(entry: ProductRegistryEntry, ref: ProductReference): void {
    if (!entry.productLinkId && ref.productLinkId) {
      entry.productLinkId = ref.productLinkId;
    }
    const specs = ref.context?.identification?.specs;
    if (specs && specs.length > 0) {
      entry.accumulatedSpecs = mergeStructuredSpecs(
        entry.accumulatedSpecs,
        specs,
      );
    }
  }

  /**
   * Add an unresolved (deferred) reference to the registry as a placeholder so
   * the cheat sheet still surfaces its name. Unlike `syncFromReference` this
   * does NOT touch existing entries — deferred refs only seed missing keys.
   */
  registerDeferredReference(
    ref: ProductReference,
    context: ThreadContext,
  ): void {
    const brand = ref.context?.identification?.brand ?? "";
    const model = ref.context?.identification?.model ?? "";
    if (!brand && !model) return;
    const key = buildRegistryKey(brand, model);
    if (context.productRegistry.has(key)) return;

    const extractedName = `${brand} ${model}`.trim();
    const entry: ProductRegistryEntry = {
      brand: brand.toLowerCase(),
      model: model.toLowerCase(),
      extractedName,
      displayName: extractedName,
      specs: undefined,
      resolvedProduct: undefined,
      candidateSet: undefined,
      inOp: false,
      recency: "latest",
      referenceCount: 0,
      maxDepth: ref.depth ?? Depth.Superficial,
    };
    this.applyLink(entry, ref);
    context.productRegistry.set(key, entry);
  }

  syncFromReference(ref: ProductReference, context: ThreadContext): void {
    const brand = ref.context?.identification?.brand ?? "";
    const model = ref.context?.identification?.model ?? "";
    if (!brand && !model) return;

    const key = buildRegistryKey(brand, model);
    const primaryModel = this.getPrimaryModel(ref);
    const candidateSet = this.snapshotCandidateSet(ref);
    const category =
      primaryModel?.productCategory?.name ??
      ref.context?.identification?.categories?.[0] ??
      undefined;
    const existing = context.productRegistry.get(key);

    if (existing) {
      // Refresh the resolution-side fields. Mention-side fields (referenceCount,
      // inOp, recency, maxDepth, mentionedAs) are left untouched.
      existing.resolvedProduct = primaryModel ?? undefined;
      existing.candidateSet = candidateSet;
      if (primaryModel) {
        existing.displayName = primaryModel.displayName;
        existing.specs = this.formatProductSpecs(primaryModel);
        if (!existing.category) {
          existing.category = primaryModel.productCategory?.name;
        }
      }
      this.applyLink(existing, ref);
      return;
    }

    // First-time entry: seed with neutral mention-side defaults. The per-
    // subtree upsert will fill these in on the next sweep.
    const extractedName = `${brand} ${model}`.trim();
    const entry: ProductRegistryEntry = {
      brand: brand.toLowerCase(),
      model: model.toLowerCase(),
      extractedName,
      displayName: primaryModel?.displayName ?? extractedName,
      specs: primaryModel ? this.formatProductSpecs(primaryModel) : undefined,
      resolvedProduct: primaryModel ?? undefined,
      candidateSet,
      inOp: false,
      recency: "latest",
      referenceCount: 0,
      maxDepth: Depth.Superficial,
      category,
      mentionedAs: undefined,
    };
    this.applyLink(entry, ref);
    context.productRegistry.set(key, entry);
  }

  // ─── Phase 7 mutation methods (called in order after each subtree) ──────

  /** Step 1: Advance recency flags for all non-OP entries. */
  shiftRecencyFlags(context: ThreadContext): void {
    for (const entry of context.productRegistry.values()) {
      if (entry.inOp) continue;
      switch (entry.recency) {
        case "latest":
          entry.recency = "recent";
          break;
        case "recent":
          entry.recency = "earlier";
          break;
      }
    }
  }

  /**
   * Step 1b: Lightweight upsert after resolution (before extraction).
   * Only touches product identity + DB specs. Does NOT read ref.depth or
   * ref.experience — those are not yet populated (extraction hasn't run).
   * Purpose: populate the cheat sheet with resolved product names + real specs so the
   * extraction prompt has accurate product context.
   */
  upsertFromResolution(
    refs: ProductReference[],
    isOpSubtree: boolean,
    context: ThreadContext,
  ): void {
    for (const ref of refs) {
      const brand = ref.context?.identification?.brand ?? "";
      const model = ref.context?.identification?.model ?? "";
      if (!brand && !model) continue;

      const primaryModel = this.getPrimaryModel(ref);
      const candidateSet = this.snapshotCandidateSet(ref);
      const key = buildRegistryKey(brand, model);
      const existing = context.productRegistry.get(key);
      const category =
        primaryModel?.productCategory?.name ??
        ref.context?.identification?.categories?.[0] ??
        undefined;
      const aliasInputs = collectAliasInputs(ref);

      if (existing) {
        existing.referenceCount += 1;
        this.refreshRecency(existing);

        if (!existing.resolvedProduct && primaryModel != null) {
          existing.resolvedProduct = primaryModel;
          existing.candidateSet = candidateSet;
          existing.displayName = primaryModel.displayName;
          existing.specs = this.formatProductSpecs(primaryModel);
          if (!existing.category) {
            existing.category = primaryModel.productCategory?.name;
          }
        } else if (!existing.category && category) {
          existing.category = category;
        }

        if (isOpSubtree && !existing.inOp) {
          existing.inOp = true;
          existing.recency = "in_op";
        }

        mergeMentionedAs(existing, aliasInputs);
        this.applyLink(existing, ref);
      } else {
        const extractedName = `${brand} ${model}`.trim();
        const entry: ProductRegistryEntry = {
          brand: brand.toLowerCase(),
          model: model.toLowerCase(),
          extractedName,
          displayName: primaryModel?.displayName ?? extractedName,
          specs:
            primaryModel != null
              ? this.formatProductSpecs(primaryModel)
              : (ref.context?.identification?.specs
                  ?.map((s) => s.value)
                  .join(", ") ?? undefined),
          resolvedProduct: primaryModel ?? undefined,
          candidateSet,
          inOp: isOpSubtree,
          recency: isOpSubtree ? "in_op" : "latest",
          referenceCount: 1,
          maxDepth: Depth.Superficial, // Placeholder — updated in post-extraction full upsert
          category,
          mentionedAs: undefined,
        };
        context.productRegistry.set(key, entry);
        mergeMentionedAs(entry, aliasInputs);
        this.applyLink(entry, ref);
      }
    }
  }

  /**
   * Refresh a re-mentioned product's recency to `latest` so an actively-
   * discussed product stays full-detail and slot-prioritized in later subtrees'
   * cheat sheets, instead of aging `latest → recent → earlier` via
   * `shiftRecencyFlags` while it's still being talked about. `in_op` is left
   * untouched — an OP product never shifts.
   */
  private refreshRecency(entry: ProductRegistryEntry): void {
    if (entry.recency !== "in_op") {
      entry.recency = "latest";
    }
  }

  /** Step 2: Upsert resolved and unresolved products from processed subtree refs. */
  upsertFromReferences(
    refs: ProductReference[],
    isOpSubtree: boolean,
    context: ThreadContext,
  ): void {
    for (const ref of refs) {
      const brand = ref.context?.identification?.brand ?? "";
      const model = ref.context?.identification?.model ?? "";
      if (!brand && !model) continue;

      const primaryModel = this.getPrimaryModel(ref);
      const candidateSet = this.snapshotCandidateSet(ref);
      const key = buildRegistryKey(brand, model);
      const existing = context.productRegistry.get(key);
      const category =
        primaryModel?.productCategory?.name ??
        ref.context?.identification?.categories?.[0] ??
        undefined;
      const aliasInputs = collectAliasInputs(ref);

      if (existing) {
        existing.referenceCount += 1;
        this.refreshRecency(existing);
        const refDepth = ref.depth ?? Depth.Superficial;
        if (DEPTH_RANK[refDepth] > DEPTH_RANK[existing.maxDepth]) {
          existing.maxDepth = refDepth;
        }

        if (!existing.resolvedProduct && primaryModel != null) {
          existing.resolvedProduct = primaryModel;
          existing.candidateSet = candidateSet;
          existing.displayName = primaryModel.displayName;
          existing.specs = this.formatProductSpecs(primaryModel);
          if (!existing.category) {
            existing.category = primaryModel.productCategory?.name;
          }
        } else if (!existing.category && category) {
          existing.category = category;
        }

        if (isOpSubtree && !existing.inOp) {
          existing.inOp = true;
          existing.recency = "in_op";
        }

        mergeMentionedAs(existing, aliasInputs);
        this.applyLink(existing, ref);
      } else {
        const extractedName = `${brand} ${model}`.trim();
        const entry: ProductRegistryEntry = {
          brand: brand.toLowerCase(),
          model: model.toLowerCase(),
          extractedName,
          displayName: primaryModel?.displayName ?? extractedName,
          specs:
            primaryModel != null
              ? this.formatProductSpecs(primaryModel)
              : (ref.context?.identification?.specs
                  ?.map((s) => s.value)
                  .join(", ") ?? undefined),
          resolvedProduct: primaryModel ?? undefined,
          candidateSet,
          inOp: isOpSubtree,
          recency: isOpSubtree ? "in_op" : "latest",
          referenceCount: 1,
          maxDepth: ref.depth ?? Depth.Superficial,
          category,
          mentionedAs: undefined,
        };
        context.productRegistry.set(key, entry);
        mergeMentionedAs(entry, aliasInputs);
        this.applyLink(entry, ref);
      }

      this.upsertResolvedProductEntry(
        key,
        ref,
        isOpSubtree,
        isOpSubtree ? "in_op" : "latest",
        aliasInputs,
        context,
      );
    }
  }

  /** Step 3: Record first-hand product affinity for author annotations. */
  updateAuthorAffinity(comments: UserComment[], context: ThreadContext): void {
    for (const comment of comments) {
      if (!comment.authorId) continue;
      const authorId = comment.authorId;

      for (const ref of comment.productReferences ?? []) {
        if (
          ref.experience !== ExperienceType.Owner &&
          ref.experience !== ExperienceType.PriorOwner &&
          ref.experience !== ExperienceType.Tested
        ) {
          continue;
        }
        const resolvedModel = this.getPrimaryModel(ref);
        if (!resolvedModel) continue;

        const existing = context.authorProductAffinity.get(authorId) ?? [];
        const alreadyTracked = existing.find(
          (e) =>
            e.product.id === resolvedModel.id &&
            e.experience === ref.experience,
        );

        if (!alreadyTracked) {
          existing.push({
            experience: ref.experience as
              | ExperienceType.Owner
              | ExperienceType.PriorOwner
              | ExperienceType.Tested,
            product: resolvedModel,
          });
          context.authorProductAffinity.set(authorId, existing);
        }
      }
    }
  }

  /**
   * Step 3b: Collapse registry entries that share the same resolvedProduct.id.
   *
   * Multiple input keys can map to entries resolved to the same DB product
   * (e.g. "MPG-341CQPX-QD-OLED" and "MSI MPG341CQPX" both resolve to the
   * same ProductModel). This merges them into a single entry keyed on the
   * resolved product's canonical brand::model, accumulating reference counts,
   * mentionedAs aliases, coverage, and picking the best recency/category.
   */
  deduplicateResolvedEntries(context: ThreadContext): void {
    const byResolvedId = new Map<
      string,
      { keys: string[]; entries: ProductRegistryEntry[] }
    >();

    for (const [key, entry] of context.productRegistry) {
      if (!entry.resolvedProduct) continue;
      const resolvedId = entry.resolvedProduct.id;
      const group = byResolvedId.get(resolvedId);
      if (group) {
        group.keys.push(key);
        group.entries.push(entry);
      } else {
        byResolvedId.set(resolvedId, { keys: [key], entries: [entry] });
      }
    }

    for (const { keys, entries } of byResolvedId.values()) {
      if (entries.length <= 1) continue;

      // Pick the highest-priority entry as canonical — prefer in_op, then
      // latest/recent over earlier, then highest referenceCount. This keeps
      // the canonical entry keyed on the original LLM-extracted name (e.g.
      // "acer::predator x34 x5") rather than re-keying it to the resolved
      // product's own brand::model (e.g. "acer::predator x34xbmiiphuzx ..."),
      // so later extractors can match colloquial mentions to the registry.
      const resolvedProduct = entries[0].resolvedProduct as ProductModel;
      const sortedByPriority = entries
        .map((entry, index) => ({ entry, key: keys[index] }))
        .sort((a, b) => {
          const recencyDiff =
            RECENCY_PRIORITY[b.entry.recency] -
            RECENCY_PRIORITY[a.entry.recency];
          if (recencyDiff !== 0) return recencyDiff;
          return b.entry.referenceCount - a.entry.referenceCount;
        });
      const { entry: canonical, key: canonicalKey } = sortedByPriority[0];

      // Merge all other entries into the canonical one
      for (const { entry } of sortedByPriority.slice(1)) {
        canonical.referenceCount += entry.referenceCount;
        if (DEPTH_RANK[entry.maxDepth] > DEPTH_RANK[canonical.maxDepth]) {
          canonical.maxDepth = entry.maxDepth;
        }
        if (entry.inOp && !canonical.inOp) {
          canonical.inOp = true;
        }
        if (
          RECENCY_PRIORITY[entry.recency] > RECENCY_PRIORITY[canonical.recency]
        ) {
          canonical.recency = entry.recency;
        }
        if (!canonical.category && entry.category) {
          canonical.category = entry.category;
        }
        // Preserve the best extractedName: prefer the in_op/highest-priority
        // entry's name (already in canonical), but fall back if canonical has none.
        if (!canonical.extractedName && entry.extractedName) {
          canonical.extractedName = entry.extractedName;
        }
        // Keep the canonical group's productLinkId; fall back if it has none.
        if (!canonical.productLinkId && entry.productLinkId) {
          canonical.productLinkId = entry.productLinkId;
        }
        if (entry.accumulatedSpecs?.length) {
          canonical.accumulatedSpecs = mergeStructuredSpecs(
            canonical.accumulatedSpecs,
            entry.accumulatedSpecs,
          );
        }
        mergeMentionedAs(canonical, entry.mentionedAs ?? []);
      }

      // Update displayName and specs from the resolved product, but keep
      // extractedName intact so the cheat sheet shows the user-facing name.
      canonical.displayName = resolvedProduct.displayName;
      canonical.specs = this.formatProductSpecs(resolvedProduct);

      // Remove all non-canonical keys; canonical stays under its original key
      for (const { key } of sortedByPriority.slice(1)) {
        context.productRegistry.delete(key);
      }

      // Ensure the canonical entry is stored under its original key
      // (it already is, since we didn't re-key it)
      if (!context.productRegistry.has(canonicalKey)) {
        context.productRegistry.set(canonicalKey, canonical);
      }
    }
  }

  /**
   * When the resolver maps the LLM-extracted brand+model to a different actual
   * product, also maintain a registry entry keyed on the resolved product's own
   * identifiers so the LLM can disambiguate in subsequent subtrees.
   */
  private upsertResolvedProductEntry(
    inputKey: string,
    ref: ProductReference,
    isOp: boolean,
    recency: ProductRegistryEntry["recency"],
    aliasInputs: string[],
    context: ThreadContext,
  ): void {
    const primaryModel = this.getPrimaryModel(ref);
    if (primaryModel == null) return;

    const resolvedBrandName = primaryModel.brand?.name ?? "";
    const resolvedModelStr = primaryModel.model ?? "";
    if (!resolvedBrandName && !resolvedModelStr) return;

    const resolvedKey = buildRegistryKey(resolvedBrandName, resolvedModelStr);
    if (resolvedKey === inputKey) return;

    const resolvedCategory = primaryModel.productCategory?.name;
    const existing = context.productRegistry.get(resolvedKey);

    if (existing) {
      existing.referenceCount += 1;
      const refDepth = ref.depth ?? Depth.Superficial;
      if (DEPTH_RANK[refDepth] > DEPTH_RANK[existing.maxDepth]) {
        existing.maxDepth = refDepth;
      }
      if (!existing.category && resolvedCategory) {
        existing.category = resolvedCategory;
      }
      if (isOp && !existing.inOp) {
        existing.inOp = true;
        existing.recency = "in_op";
      } else if (
        RECENCY_PRIORITY[recency] > RECENCY_PRIORITY[existing.recency]
      ) {
        existing.recency = recency;
      }
      mergeMentionedAs(existing, aliasInputs);
    } else {
      const entry: ProductRegistryEntry = {
        brand: resolvedBrandName.toLowerCase(),
        model: resolvedModelStr.toLowerCase(),
        extractedName: primaryModel.displayName,
        displayName: primaryModel.displayName,
        specs: this.formatProductSpecs(primaryModel),
        resolvedProduct: primaryModel,
        inOp: isOp,
        recency,
        referenceCount: 1,
        maxDepth: ref.depth ?? Depth.Superficial,
        category: resolvedCategory,
        mentionedAs: undefined,
      };
      context.productRegistry.set(resolvedKey, entry);
      mergeMentionedAs(entry, aliasInputs);
    }
  }

  /** Step 4: Render cheat sheet string and store it in context.cheatSheetString. */
  renderCheatSheet(context: ThreadContext, opts: RegistryOptions): void {
    this.deduplicateResolvedEntries(context);
    context.cheatSheetString = this.cheatSheetRenderer.render(context, opts);
  }

  // ─── Rerun replay ───────────────────────────────────────────────────────────

  /**
   * Apply the per-subtree registry mutations against an existing subtree's
   * references, mirroring the sequence in `SubtreeProcessorService.processSubtree`
   * (Phase 3b lightweight upsert + Phase 4c full updateRegistry). Used when a
   * subtree has no LLM work this run but its refs should still contribute to
   * the cheat-sheet trajectory so reruns track a fresh run.
   */
  replayProcessedSubtree(
    subtree: Subtree,
    context: ThreadContext,
    registryOpts: RegistryOptions,
  ): void {
    const refs = subtree.planNodes.flatMap(
      (node) => node.comment.productReferences ?? [],
    );
    const comments = subtree.planNodes.map((node) => node.comment);

    // Mirror Phase 3b
    this.upsertFromResolution(refs, subtree.isOpSubtree, context);
    this.renderCheatSheet(context, registryOpts);

    // Mirror Phase 4c (updateRegistry)
    this.shiftRecencyFlags(context);
    this.upsertFromReferences(refs, subtree.isOpSubtree, context);
    this.updateAuthorAffinity(comments, context);
    this.renderCheatSheet(context, registryOpts);
  }

  // ─── Private: Helpers ──────────────────────────────────────────────────────

  /** Format specs for cheat sheet display, using only extraction-relevant specs. */
  private formatProductSpecs(product: ProductModel): string {
    const contextSpecs = this.productSpecContextService.getSpecsForContext(
      product,
      product.productCategory ?? undefined,
    );
    if (contextSpecs.length > 0) {
      return contextSpecs.join(", ");
    }
    // Fallback: drop booleans — value-only rendering yields "false, true" which is
    // meaningless and can be confused with panel tokens. Keep only string/number specs.
    return (product.orderedSpecs ?? [])
      .filter(
        (spec) =>
          spec.value !== undefined &&
          spec.value !== null &&
          typeof spec.value !== "boolean",
      )
      .map((spec) => String(spec.value))
      .join(", ");
  }
}
