import type { ProductSpecs } from "./product-spec";
import type { StructuredSpec } from "./product-resolution-context";

/**
 * Persisted `ResolutionContext` shape. Lives in the database lib so the
 * `ProductReference.searchContext` column can declare a union with the legacy
 * type without creating a `database → resolution` import cycle.
 *
 * The `@ebike-backend/resolution` lib defines this shape too — that one
 * is the source of truth at runtime; this declaration mirrors it structurally
 * for the type system. The TypeORM `jsonb` column accepts either shape; rows
 * written by the legacy lib stay readable, new rows use this shape.
 */

// ─── Input + Options ─────────────────────────────────────────────────────────

export interface ProductResolutionInput {
  brand?: string;
  model?: string;
  displayName?: string;
  categoryHint?: string;
  category?: { id?: string; name: string };
  specs?: StructuredSpec[];
  referenceProductId?: string;
  referenceModel?: string;
  modelClues?: string[];
  variantClues?: string[];
  searchBefore?: Date;
  releaseYear?: number;
  contentQuality?: "high" | "medium" | "low";
}

export interface ResolutionOptions {
  useEmbedding: boolean;
  webSearchEnabled: boolean;
  mode: "strict" | "loose";
}

// ─── Phase outcomes ──────────────────────────────────────────────────────────

export interface FilterOutcome {
  qualifyingCandidateIds: string[];
  filteredCandidates: Array<{
    candidateId: string;
    candidateName?: string;
    reason: "match_specs" | "category" | "brand";
    detail: string;
  }>;
}

export interface ScoringOutcome {
  bestCandidate?: {
    candidateId: string;
    alias: string;
    score: number;
  };
  secondCandidate?: {
    candidateId: string;
    alias: string;
    score: number;
  };
  /** @deprecated Use `secondCandidate.score`. Kept for back-compat with legacy rows. */
  secondScore?: number;
  failedGates?: string[];
  normalizedInput?: string;
}

/** Persisted-JSON mirror of `FinalDecision` from `libs/resolution`. Kept in sync
 *  manually because `libs/database` cannot depend on `libs/resolution`. */
export interface FinalDecision {
  kind: "matcher_accept" | "matcher_reject" | "llm_resolved" | "llm_unresolved";
  /** 0–100 integer. Equals `max(selectedCandidates[*].confidence)` when picks exist, 0 otherwise. */
  confidence: number;
  reason: string;
  /** Candidates the resolution settled on. Length 0 for unresolved/rejected. */
  selectedCandidates: Array<{
    candidateId: string;
    confidence: number;
    reason?: string;
  }>;
  evidenceSummary?: string;
}

export interface ResolutionTotals {
  durationMs: number;
  cost: number;
  llmCalls: number;
  webSearchCalls: number;
}

export interface PhaseError {
  phase:
    | "reference_product"
    | "brand_resolution"
    | "category_resolution"
    | "recall"
    | "filter"
    | "scoring"
    | "decision"
    | "finalize";
  message: string;
  detail?: string;
  timestamp: string;
}

export interface ModelVariant {
  model: string;
  source:
    | "original"
    | "suffix_strip"
    | "normalization"
    | "brand_strip"
    | "reference_model"
    | "identification_clue";
}

// ─── Slim snapshots ──────────────────────────────────────────────────────────

export interface SlimReference {
  productId: string;
  brand?: string;
  model?: string;
  productCategory?: { id: string; name: string; slug?: string };
  specs: ProductSpecs;
}

export interface SlimResolvedModel {
  id: string;
  brand?: string;
  model?: string;
  displayName?: string;
  categoryId?: string;
  categoryName?: string;
  specs: string[];
}

export interface MatchResultComponents {
  stringSimilarity: number;
  tokenOverlap: number;
  alphaMatch: number;
  aliasMatch: boolean;
  specSimilarity: number;
}

export interface SlimCandidate {
  productId: string;
  brand?: string;
  model?: string;
  displayName?: string;
  productCategory?: { id: string; name: string; slug?: string };
  specs?: ProductSpecs;
  aliases?: string[];
  source: "fuzzy" | "embedding" | "web";
  matchScore?: number;
  matchComponents?: MatchResultComponents;
}

export interface CandidateFunnel {
  fuzzyHits: number;
  embeddingHits: number;
  webHits: number;
  afterDedupe: number;
  afterReferenceExclusion: number;
}

// ─── Web research evidence ──────────────────────────────────────────────────

export type WebQueryIntent =
  | "exact_model"
  | "model_with_specs"
  | "reference_sibling_sku"
  | "cross_market";

export interface SearchEvidence {
  title: string;
  description: string;
  url: string;
  provider: "dataforseo" | "exa";
  queryIntent: WebQueryIntent;
  modelNumbers: string[];
  resolvedProducts: Array<{
    brand: string;
    model: string;
    productId: string;
    specs: ProductSpecs;
  }>;
}

export interface WebQueryRecord {
  intent: WebQueryIntent;
  keyword: string;
  provider: "dataforseo" | "exa";
  cacheHit: boolean;
  serpResultCount: number;
}

// ─── Persisted context ──────────────────────────────────────────────────────

export interface ResolutionContext {
  input: ProductResolutionInput;
  options: ResolutionOptions;

  referenceProduct?: SlimReference;
  effectiveMatchSpecs?: ProductSpecs;

  brand?: { id: string; name: string; similarity: number };
  category?: { id: string; name: string; similarity: number };

  modelVariants: ModelVariant[];
  searchedKeywords: string[];
  searchEvidence: SearchEvidence[];
  recallFunnel?: CandidateFunnel;
  candidates: SlimCandidate[];
  strategiesRun: string[];

  webResearch?: {
    queries: WebQueryRecord[];
    extractedModelNumbers: string[];
    webOnlyModels: string[];
  };

  filter?: FilterOutcome;
  scoring?: ScoringOutcome;
  decision?: FinalDecision;

  status: "INPUT_RECEIVED" | "RESOLVED" | "UNRESOLVED";
  resolvedProduct?: SlimResolvedModel;

  totals: ResolutionTotals;
  errors: PhaseError[];
}

/**
 * Type guard: detect new-shape rows at runtime so readers can branch between
 * legacy and current shapes without type-system gymnastics. The current shape
 * always carries `totals` + `errors` as top-level fields (legacy nests them
 * differently) and uses a `decision.kind` enum the legacy decision shape
 * never had.
 */
export function isResolutionContext(
  value: unknown,
): value is ResolutionContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ResolutionContext> &
    Record<string, unknown>;
  if (!Array.isArray(candidate.modelVariants)) return false;
  if (!Array.isArray(candidate.candidates)) return false;
  if (!Array.isArray(candidate.strategiesRun)) return false;
  if (typeof candidate.totals !== "object" || candidate.totals === null)
    return false;
  // The legacy context has no `strategiesRun` field and renders modelVariants
  // with a `searched: boolean` field on each entry. The current shape has no
  // `searched` field.
  const firstVariant = candidate.modelVariants?.[0] as
    | { searched?: unknown }
    | undefined;
  if (firstVariant && "searched" in firstVariant) return false;
  return true;
}
