import type { MatchResult, ProductSpecs } from "@ebike-backend/database";
import type { ProductResolutionInput } from "./resolution-input";
import type { ResolutionOptions } from "./resolution-options";
import type { ResolutionStatus } from "./resolution-status";
import type {
  CandidateFunnel,
  SlimCandidate,
  SlimReference,
  SlimResolvedModel,
} from "./slim-types";
import type { SearchEvidence, WebQueryRecord } from "./search-evidence";

/** Filter outcome — which candidates survived the category + effectiveMatchSpecs
 *  gates, and which were dropped (with reason). */
export interface FilterOutcome {
  qualifyingCandidateIds: string[];
  filteredCandidates: Array<{
    candidateId: string;
    /** Human-readable candidate label (brand + model / displayName) for trace
     *  clarity — saves readers from cross-referencing candidateId against
     *  `ctx.candidates`. */
    candidateName?: string;
    reason: "match_specs" | "category" | "brand";
    detail: string;
  }>;
}

/** Aggregate scoring snapshot for the persisted context. The matcher's
 *  per-candidate components live on each `SlimCandidate.matchComponents`; this
 *  block records the cross-cutting diagnostics — best/runner-up + failed gates. */
export interface ScoringOutcome {
  bestCandidate?: {
    candidateId: string;
    alias: string;
    /** 0–100 integer matcher score. */
    score: number;
  };
  /** Runner-up candidate identity and score. Consumers should prefer this over
   *  the deprecated `secondScore` so they can look up the runner-up's
   *  `matchComponents` on `context.candidates` for best-vs-second comparisons. */
  secondCandidate?: {
    candidateId: string;
    alias: string;
    /** 0–100 integer matcher score. */
    score: number;
  };
  /** @deprecated Use `secondCandidate.score`. Kept for back-compat with rows
   *  persisted before `secondCandidate` was introduced. */
  secondScore?: number;
  /** Gate names from `quality-gates.service.ts` (e.g. `low_confidence_anchored`). */
  failedGates?: string[];
  /** Normalized input string the matcher actually scored against (for traces). */
  normalizedInput?: string;
}

/** Final-decision shape. Confidence is on the unified 0–100 integer scale.
 *
 *  Non-empty `selectedCandidates` ⇒ `matcher_accept` or `llm_resolved`.
 *  Empty `selectedCandidates` ⇒ `matcher_reject` or `llm_unresolved`. */
export interface FinalDecision {
  kind: "matcher_accept" | "matcher_reject" | "llm_resolved" | "llm_unresolved";
  /** 0–100 integer. Equals `max(selectedCandidates[*].confidence)` when picks exist, 0 otherwise. */
  confidence: number;
  /** Short reason code: `reference_same`, `registry_hit`, `below_accept_threshold`,
   *  `family_only_evidence`, `no_qualifying_candidates`, `llm_returned_none`,
   *  `no_candidates_above_threshold`, etc. */
  reason: string;
  /** Candidates the resolution settled on. Length 0 for unresolved/rejected
   *  decisions; length ≥ 1 when resolved. The first entry (by convention,
   *  enforced by the applier) is the primary pick — highest confidence. */
  selectedCandidates: Array<{
    candidateId: string;
    /** 0–100 integer. matchScore on the matcher path, LLM-reported confidence on the LLM path. */
    confidence: number;
    /** Short reason — 'matcher_accept' / 'matcher_accept_above_threshold' on the
     *  matcher path, 1-sentence LLM rationale on the LLM path. */
    reason?: string;
  }>;
  /** Human-readable evidence summary (from the decision LLM, or synthesized). */
  evidenceSummary?: string;
}

/** Aggregated metrics rolled up across stages. */
export interface SearchTotals {
  durationMs: number;
  /** Total USD cost across LLM calls in this run. */
  cost: number;
  llmCalls: number;
  webSearchCalls: number;
}

/** A phase-tagged error captured during a run. Non-fatal — recoverable failures
 *  are recorded and surfaced on the persisted artifact, not thrown. */
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

/** A model-variant seed produced by `buildModelVariants` and consumed by recall
 *  strategies. Recorded on the context for trace clarity (which seeds fired). */
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

/**
 * v2 persisted context. Built incrementally as the pipeline runs; the final
 * value is what gets stored on `ProductReference.searchContext`.
 *
 * One copy of the input. One status field. One block per phase. Confidence on a
 * single 0–100 integer scale.
 *
 * The orchestrator mutates this in place as stages execute. There is no
 * separate "working ctx" type — the same fields that get persisted are the
 * fields the strategies read from and write to during the run.
 */
export interface ResolutionContext {
  // ── Identification ─────────────────────────────────────────────────────────
  /** Frozen at entry; never mutated. */
  input: ProductResolutionInput;
  /** `input.specs` converted to a ProductSpecs map, memoized so stages don't
   *  re-run `structuredSpecsToProductSpecs(input.specs)` per resolution.
   *  Transient — never persisted. Populated lazily via `getInputSpecsMap`. */
  inputSpecsMap?: ProductSpecs;
  options: ResolutionOptions;
  /** Thread the resolution belongs to. Transient — never persisted. Read by
   *  stages that issue LLM calls so per-thread cost accounting captures
   *  resolution spend (`DebugTraceService.recordLlmCallUsage`). */
  threadId?: string;

  // ── Reference-product resolution (Stage 1 output) ──────────────────────────
  referenceProduct?: SlimReference;
  effectiveMatchSpecs?: ProductSpecs;

  // ── Brand + category (Stage 1 OR Stage 2 output) ───────────────────────────
  /** `similarity = 1.0` when set by Stage 1 (reference-derived). */
  brand?: { id: string; name: string; similarity: number };
  /** `similarity = 1.0` when set by Stage 1 or from `input.category.id`. */
  category?: { id: string; name: string; similarity: number };

  // ── Recall (Stage 3 output) ────────────────────────────────────────────────
  /** Variant seeds the recall strategies generated, recorded for trace. */
  modelVariants: ModelVariant[];
  /** Base variant seeds from `buildModelVariants(input)`, memoized so the fuzzy
   *  and embedding strategies don't recompute the same seeds in one pass.
   *  Transient — never persisted. */
  baseModelVariants?: ModelVariant[];
  /** Normalized keyword ledger used to dedupe SERP queries within a single
   *  `WebRecall.recall()` call. Cleared/reset per run. */
  searchedKeywords: string[];
  /** Per-record SERP evidence accumulated by `WebRecall`. */
  searchEvidence: SearchEvidence[];
  /** Funnel counts for the recall phase. */
  recallFunnel?: CandidateFunnel;
  /** All recall candidates (post-dedupe, post-reference-exclusion). Each entry
   *  carries the matcher score after Stage 5 runs. */
  candidates: SlimCandidate[];
  /**
   * Append-only sequence recording every recall-strategy fire, in order. A
   * strategy that fires N times appears N times. Read by strategy `shouldRun`
   * gates that want to enforce single-shot semantics (e.g. fuzzy checks
   * `!strategiesRun.includes('fuzzy')`) and by the orchestrator's fixed-point
   * recall loop, which detects convergence by comparing `length` before and
   * after each `RecallService.recall()` call. Load-bearing: do not mutate
   * outside `RecallService`.
   */
  strategiesRun: string[];

  // ── Web research metadata (Stage 3 output, when WebRecall fired) ───────────
  webResearch?: {
    queries: WebQueryRecord[];
    /** Deduped aggregate of `searchEvidence[*].modelNumbers`. */
    extractedModelNumbers: string[];
    /** Extracted SKUs that didn't resolve to a catalog product. */
    webOnlyModels: string[];
  };

  // ── Filter (Stage 4 output) ────────────────────────────────────────────────
  filter?: FilterOutcome;

  // ── Scoring (Stage 5 output) ───────────────────────────────────────────────
  scoring?: ScoringOutcome;
  /** Full set of per-candidate match results produced by the matcher, in
   *  descending score order. Transient — never persisted onto
   *  `ProductReference.searchContext` (the persisted form is `scoring` +
   *  per-candidate `matchComponents`). Read by the decision stage to feed
   *  `QualityGatesService.filterAcceptable`. */
  scoringMatches?: MatchResult[];
  /** Parsed input + category config carried forward from scoring so the
   *  decision stage can re-run `filterAcceptable` without re-deriving them.
   *  Transient — not persisted. Untyped here to avoid pulling category-config
   *  types into this module's deps; the scoring service writes these and the
   *  decision service reads them with `as` casts. */
  scoringInputParsed?: unknown;
  scoringMatchConfig?: unknown;

  // ── Decision (Stage 6 output) ──────────────────────────────────────────────
  decision?: FinalDecision;

  // ── Terminal outcome ───────────────────────────────────────────────────────
  status: ResolutionStatus;
  resolvedProduct?: SlimResolvedModel;

  // ── Cross-cutting ──────────────────────────────────────────────────────────
  totals: SearchTotals;
  errors: PhaseError[];
}
