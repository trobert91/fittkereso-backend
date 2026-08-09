import {
  Depth,
  ExperienceType,
  ProductModel,
  StructuredSpec,
} from "@ebike-backend/database";

// ─── ProductRegistryEntry ────────────────────────────────────────────────────

/**
 * One entry in the product registry — tracks a product seen anywhere in the thread.
 * Used for cheat sheet rendering and cross-subtree context.
 */
export interface ProductRegistryEntry {
  /** Lowercase brand name. Key component of the registry map key `${brand}::${model}`. */
  brand: string;

  /** Canonical model string. Stored lowercase for deduplication. */
  model: string;

  /**
   * The name as originally extracted from the first mention in this thread
   * (e.g. "Acer Predator X34 X5"). Shown in the cheat sheet so the extractor
   * can match colloquial references in later comments to the same registry key.
   * Never overwritten after first insertion — distinct from displayName which
   * reflects the resolved DB product name.
   */
  extractedName: string;

  /** Human-readable display name shown in the cheat sheet. */
  displayName: string;

  /** Formatted spec string (e.g. '34", QD-OLED, 240Hz'). Undefined for unresolved products with no spec info. */
  specs?: string;

  /** The resolved DB entity (primary candidate's model). Undefined when unresolved. */
  resolvedProduct?: ProductModel;

  /**
   * Full candidate set for the most recent resolution behind this registry
   * entry — primary first, runners-up after. Mirrors what
   * `ResolutionResultApplierService.apply()` writes to
   * `ProductReference.candidates`. Used so `referenced`-type identification
   * hits can copy the full set onto child references and preserve ambiguity.
   *
   * Stores plain { model, weight, confidence, isPrimary } shapes — not the
   * ORM entity — because the registry is rebuilt across runs and the entity
   * `id`s belong to the source reference, not the registry-level snapshot.
   */
  candidateSet?: Array<{
    model: ProductModel;
    weight: number;
    confidence: number;
    isPrimary: boolean;
  }>;

  /** Whether the product appeared in the OP comment body. Permanent — never set back to false. */
  inOp: boolean;

  /**
   * Recency tier for cheat sheet slot allocation and detail level.
   * Shifts at end of each subtree: latest → recent → earlier. 'in_op' never shifts.
   */
  recency: "in_op" | "latest" | "recent" | "earlier";

  /** Number of PLAN comments across all processed subtrees that mention this product. */
  referenceCount: number;

  /** Best depth level seen across all references to this product. */
  maxDepth: Depth;

  /** General product category (e.g. "monitor", "headphones"). Populated from the resolved product or extraction hint. */
  category?: string;

  /** Alias names users have called this product across the thread, sourced
   *  from each ref's identification.modelClues + identification.variantClues.
   *  Rendered in the cheat sheet as `(mentioned as: ...)` so the extraction
   *  LLM can recognise the same product across casual user phrasings. */
  mentionedAs?: string[];

  /** Same-product `productLinkId` UUID for this entry, captured from the first
   *  reference that created it (first-write-wins). Later references that hit
   *  this entry inherit it, carrying the group across subtrees. */
  productLinkId?: string;

  /** Union of structured specs stated across every reference to this product in
   *  the thread (deduped by spec name, first value wins). Pooled into the
   *  resolution input so a later attempt benefits from all mentions' evidence. */
  accumulatedSpecs?: StructuredSpec[];
}

// ─── AuthorAffinityEntry ─────────────────────────────────────────────────────

/**
 * One entry in the per-author affinity list — records a resolved product and
 * the experience type that qualified it for tracking.
 */
export interface AuthorAffinityEntry {
  /** ExperienceType.Owner, ExperienceType.PriorOwner, or ExperienceType.Tested — the qualifying experience. */
  experience:
    | ExperienceType.Owner
    | ExperienceType.PriorOwner
    | ExperienceType.Tested;
  /** The resolved DB product entity. Always non-null — unresolved products are never tracked. */
  product: ProductModel;
}

// ─── Registry Key Utilities ──────────────────────────────────────────────────

/**
 * Build a normalized registry key from brand and model.
 * Format: `${brand}::${model}` (both lowercase).
 */
export function buildRegistryKey(brand: string, model: string): string {
  return `${brand.toLowerCase()}::${model.toLowerCase()}`;
}

/**
 * Resolve a brand+model pair to the best matching registry key.
 * Tries exact match first, then suffix/substring scan within the same brand.
 * Falls back to the raw normalized key if no match is found.
 */
export function resolveRegistryKey(
  brand: string,
  model: string,
  registry: Map<string, ProductRegistryEntry>,
): string {
  const lcBrand = brand.toLowerCase();
  const lcModel = model.toLowerCase();
  const exactKey = `${lcBrand}::${lcModel}`;

  // Strategy 1: exact key match
  if (registry.has(exactKey)) return exactKey;

  // Strategy 2: suffix/substring scan within same brand
  if (lcModel.length > 0) {
    for (const [registryKey, entry] of registry) {
      if (entry.brand !== lcBrand) continue;
      const registryModel = entry.model;
      if (registryModel.endsWith(lcModel) || lcModel.endsWith(registryModel)) {
        return registryKey;
      }
    }
  }

  // Strategy 3: no registry match — use raw key
  return exactKey;
}

// ─── RegistryOptions ─────────────────────────────────────────────────────────

/**
 * Slot/size limits sourced from DynamicConfigData.processor.cheatSheet.
 * Passed into ProductRegistryService methods by the orchestrator.
 */
export interface RegistryOptions {
  maxProducts: number;
  maxOpSlots: number;
  maxChars: number;
  lowRefThreshold: number;
  /** Minimum guaranteed cheat sheet slots per distinct product category. */
  minSlotsPerCategory: number;
}
