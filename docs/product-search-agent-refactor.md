# Product Resolution Agent Redesign

## Motivation

`ProductSearchAgent` makes confident but wrong picks when a comment names a model number whose specs conflict with the surrounding context. The trigger case:

- Thread anchor: `Samsung Odyssey OLED G8 S34DG850SU` (34" ultrawide, 3440x1440).
- Comment 2995b610: *"There's a newer version of this model with full size ports. G8sd I think it's called…"*
- `WebResearchAgent` correctly identified `G80SD / LS32DG802SNXZA` — but that is a **32" 16:9 4K** monitor, not a newer version of a 34" ultrawide.
- `ContextualResolutionAgent` picked `S32DG800SU` (32" 16:9 OLED) at confidence 85, explicitly acknowledging the form-factor switch in its reason. `ProductMatcherService` had already rejected it via `low_confidence_anchored` (score 51 < 78), but `ContextualResolutionAgent` overrode that rejection.

The root failure is that `ProductSearchAgent` treats the model number as the dominant signal and only treats anchor/form-factor as a soft hint. When the comment frames the mention as a successor/variant of the anchor ("newer version of this model", "the same one but…", "the 34 inch version of X"), the form factor is part of the claim — not just background context — and a candidate that contradicts it should be rejected even if the model number is a strong literal match.

## Summary

Replace the current multi-agent loop in `ProductSearchAgent` with an evidence-first design that is conservative by default. `ProductSearchAgent` takes a self-contained input that describes (a) the search target and (b) the per-dimension match conditions a candidate must satisfy, and treats any violation of those match conditions as a hard rejection:

1. Normalize the mention; extract model-number clues from the mention and the comment body.
2. Search the catalog for candidates using all known model tokens.
3. Run a focused web research step only when needed; extract model numbers and specs from SERPs.
4. Re-search the catalog with model numbers discovered from the web.
5. Pre-filter candidates against the input's match conditions and the category constraint, then let one final LLM adjudicator pick from the qualifying list (or return `none`). The LLM never sees a candidate that violates the hard constraints.

Final acceptance is conservative: when evidence does not clearly identify one catalog candidate that satisfies all required match conditions, return `UNRESOLVED` rather than the closest model-number match. Building those match conditions from the cheat sheet, comment overrides, and subject-switch detection is `ResolutionInputEnricher`'s responsibility, not `ProductSearchAgent`'s.

## Current System Findings

- `ProductSearchAgent` is already an agent loop, but responsibilities are scattered across `InputEnrichmentAgent`, `CandidateSearchAgent`, `CandidateMatcherAgent`, `WebResearchAgent`, `ContextualResolutionAgent`, and `ResultAssemblyAgent`.
- `WebResearchAgent` does too much: query construction, search execution, SERP extraction, regional variant discovery, direct candidate ranking, context mutation, and status control.
- `ContextualResolutionAgent` only runs after web search and only when `contextualResolutionEnabled` and `threadContext` are provided, so many resolutions still bypass the LLM/context decision step.
- The product-identity-first flow (`ResolutionInputEnricher` → `SubtreeProcessorService` → `ProductSearchAgent`) already passes `threadContext` and `commentBody`; the older `ProductReferenceResolutionService` path does not, so context-aware resolution is inconsistent.
- `CandidateMatcherAgent` can accept a match before OP/comment/thread context is considered — fast, but not aligned with the desired "`ContextualResolutionAgent` decides with full context" behavior.
- Web search uses hand-built query branches. It should produce a small ranked query plan from the mention, model clues, specs, category, anchor product, and failure reason.
- **`ContextualResolutionAgent`'s prompt has no hard form-factor / category constraints.** It lists subreddit and "other resolved products" as soft hints ("if web search points to ultrawide, prefer that") but does not enforce that a candidate violating the anchor's form factor must be rejected unless the comment explicitly contradicts the anchor.
- **`ProductMatcherQualityGateService`'s `low_confidence_anchored` gate is correctly conservative**, but `ContextualResolutionAgent` overrides it without re-applying the same gate. `ContextualResolutionAgent`'s confidence number is not gated against the same evidence the matcher used.
- **The identification LLM produces a free-text `searchKeyword`** that `ProductSearchAgent` only uses in two places: `web-research.agent.ts:604-630` `buildProductKeyword` (where there's already a fallback compiler when it's absent) and `contextual-resolution.service.ts:169-170` (rendered as a soft prompt hint). All the information it carries (`brand`, `model`, `referenceModel`, `modelClues`, `variantClues`, specs, category disambiguation) is already present in the structured fields; the keyword is just the LLM's prose stitching of them. It's a cost the pipeline doesn't need to pay — and removing it is consistent with `ProductSearchAgent` becoming deterministic given its structured input.

## Key Changes

### 1. Collapse the agent set

Replace the current subagent set under `libs/product-resolution/src/lib/search-agent` with four clearer collaborators:

- `ProductSearchOrchestrator` — fixed flow and budget control; no LLM calls. Replaces today's `ProductSearchAgent.execute` loop.
- `ProductCandidateDiscoveryService` — brand/category enrichment plus fuzzy/alias/model/embedding candidate search.
- `ProductWebResearchService` — query planning, provider search, SERP normalization, model-number extraction, and evidence packaging.
- `ProductResolutionDecisionService` — the single LLM adjudication step; returns `resolved`, `unresolved`, or `reject_candidates`.

For brevity, the rest of this doc continues to refer to the entry-point class as `ProductSearchAgent`; in the new layout it is `ProductSearchOrchestrator`.

### 2. The `ProductResolutionInput` shape: search target + spec overrides + reference

`ProductResolutionInput` (in `libs/database/src/lib/models/product-resolution-context.ts`) has three distinct roles, and the caller (`ResolutionInputEnricher` for the product-identity-first path, `ProductReferenceResolutionService` for the legacy path) populates each one independently:

- **Search target** — `brand`, `model`, `displayName`, `modelClues`, `variantClues`, `categoryHint`. These describe the product the comment is naming. (`searchKeyword` is dropped — see §4.)
- **Spec overrides** — `specs` (per-dimension overrides the comment explicitly mentioned, e.g. `screenSize=39`). This stays as-is from today: only comment-mentioned specs go in. The semantics are *overrides*, not the full required-spec set.
- **Reference product** — `referenceProductId` (and the related `referenceModel`). When set, it identifies the catalog product the comment is anchoring to. `ProductSearchAgent` uses it for three things: as the source of inherited primary specs, as a candidate exclusion (the reference itself can't be the answer), and as a sibling-SKU search seed.

The match conditions a candidate must satisfy are computed inside `ProductSearchAgent` (becoming `ProductSearchOrchestrator` after §1's collapse), the entry-point service in `libs/product-resolution/src/lib/search-agent/product-search-agent.service.ts`. It is the layer that owns the resolution loop — distinct from the upstream `ProductReferenceResolutionService` in `libs/thread-processor`, which only builds the `ProductResolutionInput` and dispatches into `ProductSearchAgent`. The match conditions are derived by overlaying `input.specs` on top of the reference product's primary specs:

- `effectiveMatchSpecs = referenceProduct.specs ∩ primarySpecs`, with every entry in `input.specs` overriding per dimension.
- Example: cheat-sheet has `LG 34GS95QE` (34", 3440x1440, 240Hz, 800R, OLED), comment says "the 39 inch version" → `input.specs = [screenSize=39]`, `ProductSearchAgent` computes `effectiveMatchSpecs = [screenSize=39, resolution=3440x1440, refreshRate=240, curvature=800R, panelType=OLED]` and feeds *that* to `ProductCandidateDiscoveryService` (the matcher) and `ProductResolutionDecisionService` (the post-LLM gate).
- When `referenceProductId` is unset, `effectiveMatchSpecs` is just `input.specs` — same as today.

The overlay runs in `ProductSearchAgent.execute` early in the resolution flow: when `input.referenceProductId` is set, the orchestrator fetches the reference product via `ProductModelRepository.findByIdForPipeline` (the same call today's anchor-fetch block at lines 73-89 makes), populates `context.reference` with the slim primary-spec subset (§7), and computes `context.effectiveMatchSpecs`. Both `ProductCandidateDiscoveryService` (the §3 pre-filter) and `ProductResolutionDecisionService` read `effectiveMatchSpecs` from the context. `ResolutionInputEnricher` does not change its current behavior; `input.specs` keeps its existing semantics ("what the comment said about the product"). One overlay site, not duplicated in two consumers — and not pushed up into `ProductReferenceResolutionService`, which doesn't fetch the reference entity today.

The reference-exclusion role is currently enforced by `ProductMatcherQualityGateService.evaluateAnchored`'s `anchor_self_match` gate, which fires *after* `ProductMatcherService` has scored everything. This is the wrong layer: `ProductMatcherService` does pointless work ranking a candidate that cannot win, and the ambiguity-gap check then has to special-case "what if the runner-up is the reference?" The exclusion belongs in candidate discovery — `ProductCandidateDiscoveryService` filters out `referenceProductId` from the candidate list before scoring, and `ProductWebResearchService` candidates that come back as the reference itself are filtered the same way. `ProductMatcherQualityGateService.evaluateAnchored` then collapses to its remaining purpose: a stricter score floor and wider ambiguity gap for variant resolution. `anchor_self_match` is removed.

The subject-switch case ("I switched to the LG 27GR95" with a cheat-sheet `referenceProductId` set) needs a small classifier in `ResolutionInputEnricher` so `ProductSearchAgent` doesn't inherit specs from a reference the comment isn't actually about. The classifier (rule-based for obvious cues like "switched to", "instead I got", "I prefer the X"; small LLM fallback only when rules are inconclusive) clears `referenceProductId` when it fires, so `ProductSearchAgent` treats the input as unanchored. This is the only piece of *new* logic in `ResolutionInputEnricher`.

### 3. Pre-filter candidates against match conditions and category

Match conditions are enforced as a **pre-filter on the candidate list before the LLM is invoked** — not as a post-hoc gate on the LLM's pick. The LLM only ever sees candidates that already satisfy the constraints, so its job is purely disambiguation between candidates that all qualify.

**Spec filter:** for every spec in `effectiveMatchSpecs` (computed as described in §2 — reference product's primary specs overlaid with `input.specs`), each candidate's spec on that dimension must match using the same `SpecComparisonService` semantics `ProductMatcherService` already uses (so `matcherSpecHierarchies` for compatible values keeps working). Candidates that fail are dropped from the list shown to the LLM.

**Category filter:** the effective category constraint comes from the reference product when `referenceProductId` is set — its `productCategory` is authoritative and overrides `input.categoryHint`. The reference's category is captured on `context.reference.productCategory` during the §2 reference-resolution step (replacing today's `context.categories` prefill from `anchorEntity.productCategory` at lines 99-105). When `referenceProductId` is unset, the filter falls back to `input.categoryHint`. Candidates with a disagreeing category are dropped.

**Empty filtered list → `unresolved` directly.** If filtering empties the candidate list, `ProductResolutionDecisionService` returns `unresolved` without calling the LLM. The dropped candidates are recorded on `ProductSearchContext` as `filteredCandidates` (with the reason — `match_specs` or `category`) for trace visibility.

**The LLM's contract becomes simpler:** pick one of the qualifying candidates or return `none`. There's no spec-conflict reasoning to do — the prompt no longer needs to render `effectiveMatchSpecs` as constraints the LLM must enforce, only as context. The trigger case is caught structurally: the 32" candidate doesn't pass the spec filter (`screenSize` 32 ≠ 34), so the LLM never sees it and cannot pick it. The matcher's existing `low_confidence_anchored` and `ambiguous_match_anchored` diagnostics stay as evidence the LLM reads, but they cannot be silently overridden because the filter has already enforced the hard constraints.

### 4. `ProductWebResearchService` becomes evidence-only

`ProductWebResearchService` no longer ranks candidates or directly proposes a resolution. It produces structured evidence:

- **Compiles its own search keywords from the structured input.** `searchKeyword` is dropped from `ProductResolutionInput` and from the identification LLM schema (`subtree-identification.schema.ts`) along with the per-category `searchKeywordInstruction` config field. The identification LLM no longer produces a free-text query string; `ProductWebResearchService` compiles deterministic queries from `brand`, `model`, `referenceModel`, `modelClues`, `variantClues`, `effectiveMatchSpecs`, and a per-category disambiguation suffix (a new `searchKeywordSuffix` config field on `CategoryMatchConfig` carrying the category-distinguishing tokens — e.g. `"monitor"` / `"ultrawide monitor"` / `"IEM"` vs. `"headphones"` / `"projector"` — that the old `searchKeywordInstruction` used to teach the identification LLM). Today's fallback compiler in `web-research.agent.ts:604-630` (`buildProductKeyword`) is the seed for this; it gets extended to handle the variant case (combine `referenceModel` + `modelClues` + `variantClues` for sibling-SKU queries) and to pull the disambiguation suffix from category config. Same construction the identification LLM was doing, but reproducible, cacheable, and unit-testable.
- Generates 2–4 query intents from the compiled fields: exact model, model + category/specs, anchored sibling SKU, regional/equivalent model.
- Prefers exact quoted model-number searches for DataForSEO and semantic/spec-rich searches for Exa.
- Normalizes raw SERPs into `SearchEvidence` records — one per SERP result. Initial shape (before extraction and re-search):

  ```ts
  SearchEvidence = {
    title: string;
    description: string;
    url: string;
    provider: 'dataforseo' | 'exa';
    queryIntent: string;
    // Populated by the extraction LLM:
    modelNumbers: string[];                     // SKUs found in this record's text
    // Populated by catalog re-search:
    resolvedProducts: Array<{
      brand: string;
      model: string;
      productId: string;
      specs: Partial<Record<PrimarySpecKey, StructuredSpecValue>>; // restricted to primarySpecs
    }>;
  }
  ```

- **Runs an LLM extraction pass over the SERP set** with a single, narrow purpose: for each SERP record, return the model numbers that appear in that record's title/description/url and look like real SKUs for the input brand. The LLM sees the input brand, the model fragments the comment used, the anchor product (when set), and the SERP records, and writes its output back per-record (the `modelNumbers` field on each `SearchEvidence`). The trigger case shows why this needs an LLM rather than regex: SERP titles mix marketing names (`G80SD`), full SKUs (`LS32DG802SNXZA`, `S32DG80`), and family aliases (`G8/G80SD`), and a regex pass cannot tell which is a real SKU vs. a parent family vs. unrelated noise. The prompt forbids inventing model numbers not present in the SERP record.
- Aggregates the per-record `modelNumbers` into a deduplicated `extractedModelNumbers: string[]` for catalog re-search.
- Searches the catalog with each extracted model number against the input brand, using the existing fuzzy-lookup path. Catalog hits are written back into the `resolvedProducts` field of every `SearchEvidence` record whose `modelNumbers` contained that SKU (so a single record can carry multiple resolutions when its text mentions several SKUs that all resolve, and a single resolved product can appear on multiple records when the same SKU was mentioned in several SERPs). Specs are restricted to `primarySpecs` to keep the prompt compact — that's the same set `effectiveMatchSpecs` uses, so it's also exactly what the post-LLM gate will compare against. Unresolved model numbers stay in `modelNumbers` (they're still part of the SERP-text evidence) and are also surfaced at the top level as `webOnlyModels: string[]`, so the prompt can render lines like *"this record mentions `G80SD` which isn't in our catalog and `S32DG80` which is (catalog product: …)"*.
- `ProductResolutionDecisionService` receives the **full `SearchEvidence` array** rendered into its prompt — title, description, url, the model numbers extracted from that record's text, and the catalog-resolved products with their primary specs all in one place per record. Catalog specs — not SERP-derived specs — are what the post-LLM gate evaluates against `effectiveMatchSpecs`; the SERP text is *evidence the LLM reasons over*, not a source of constraints.

### 5. Single final decision schema

`ProductResolutionDecisionService` returns:

```ts
{
  decision: 'resolved' | 'unresolved',
  selectedCandidateId?: string,
  confidence: number,
  evidenceSummary: string,
  uncertaintyReasons: string[],
  // 'no_qualifying_candidates' when the pre-filter emptied the list and the LLM was skipped;
  // 'llm_returned_none' when the LLM saw qualifying candidates but declined to pick;
  // 'low_confidence' when the pick was below the acceptance threshold; etc.
  unresolvedReason?: string,
  shouldCreateAliases: Array<{ model: string; region?: string; candidateId: string }>,
}
```

### 6. Conservative acceptance

- Accept only if `ProductResolutionDecisionService` selects a catalog candidate from the (already pre-filtered) qualifying list with confidence above the configured threshold and an explanation that cites comment/thread/web/catalog evidence. Spec contradictions cannot reach this stage — they're filtered structurally per §3.
- Remain unresolved when the pre-filter empties the candidate list, when the LLM returns `none` despite qualifying candidates being available, when the pick is below the acceptance threshold, or when only family-level evidence exists (e.g. "G80SD family" matched but no SKU) and no qualifying candidate consistently matches.
- Preserve `ProductMatcherQualityGateService` diagnostics (`low_confidence_anchored`, `ambiguous_match_anchored`, etc.) as evidence shown to `ProductResolutionDecisionService`'s LLM, so it can prefer high-confidence picks over weak ones in the qualifying list. (`anchor_self_match` no longer exists — the reference product is filtered out by `ProductCandidateDiscoveryService` before the matcher runs.)

### 7. `ProductSearchContext`

The existing `ProductSearchContext` (libs/database/src/lib/models/product-search-context.ts) is replaced — no backward compatibility, all pre-existing data is wiped. The new shape is organized phase-by-phase to mirror §1's collapse, with each phase's inputs and outputs captured side-by-side so a reader can scan the trace top-to-bottom and see what every step decided and why.

```ts
ProductSearchContext = {
  // ── Identification ───────────────────────────────────────────────────────
  // The input dispatched into ProductSearchAgent. Frozen at entry; never mutated.
  input: ProductResolutionInput;
  options: ProductSearchOptions;

  // ── Reference resolution ─────────────────────────────────────────────────
  // Populated when input.referenceProductId is set (the cheat-sheet/anchor case).
  reference?: {
    productId: string;
    brand: string;
    model: string;
    productCategory: { id: string; name: string };
    specs: Partial<Record<PrimarySpecKey, StructuredSpecValue>>; // restricted to primarySpecs
  };

  // The per-dimension required match conditions §3 enforces.
  // = reference.specs ∩ primarySpecs, overlaid by input.specs.
  // Empty when there's no reference and the comment mentioned no specs.
  effectiveMatchSpecs: Partial<Record<PrimarySpecKey, StructuredSpecValue>>;

  // ── Phase 1: candidate discovery (ProductCandidateDiscoveryService) ──────
  candidateDiscovery: {
    brand?: { id: string; name: string };
    categories: Array<{ id: string; name: string }>;
    funnel: {
      fuzzyHits: number;
      embeddingHits: number;
      aliasHits: number;
      modelTokenHits: number;
      afterDedupe: number;
      afterReferenceExclusion: number; // candidates left after dropping referenceProductId
    };
    candidates: SlimCandidate[]; // see below
    matcherDiagnostics: MatcherDiagnostics; // low_confidence_anchored / ambiguous_match_anchored / etc.
    durationMs: number;
  };

  // ── Phase 2: web research (ProductWebResearchService) ────────────────────
  // Populated only when discovery alone didn't yield a confident match.
  webResearch?: {
    skipped?: { reason: 'high_confidence_match' | 'web_search_disabled' | 'cache_only' };
    queries: Array<{
      intent: 'exact_model' | 'model_with_specs' | 'sibling_sku' | 'cross_market';
      keyword: string;
      provider: 'dataforseo' | 'exa';
      cacheHit: boolean;
      serpResultCount: number;
      durationMs: number;
      cost: number;
    }>;
    searchEvidence: SearchEvidence[]; // the §4 structure — flat across all queries
    extractionLlm: {
      cost: number;
      durationMs: number;
    };
    extractedModelNumbers: string[]; // deduped aggregate of searchEvidence[*].modelNumbers
    webOnlyModels: string[];          // extracted SKUs that didn't resolve to a catalog product
    addedCandidateIds: string[];      // catalog hits added to candidateDiscovery.candidates from web models
    durationMs: number;
  };

  // ── Phase 3: pre-filter (§3) ─────────────────────────────────────────────
  // Runs before the decision LLM. Empty filteredCandidates means everything qualified.
  preFilter: {
    qualifyingCandidateIds: string[];
    filteredCandidates: Array<{
      candidateId: string;
      reason: 'match_specs' | 'category';
      detail: string; // e.g. "screenSize 32 ≠ 34", "category 'tv' ≠ 'monitor'"
    }>;
  };

  // ── Phase 4: decision (ProductResolutionDecisionService) ─────────────────
  // Skipped (decision='unresolved', unresolvedReason='no_qualifying_candidates') when preFilter empties the list.
  decision: {
    skipped?: { reason: 'no_qualifying_candidates' };
    llm?: {
      cost: number;
      durationMs: number;
    };
    result: FinalDecision; // the §5 schema
  };

  // ── Outcome ──────────────────────────────────────────────────────────────
  status: 'RESOLVED' | 'UNRESOLVED';
  resolvedProduct?: SlimResolvedModel; // populated when status='RESOLVED'

  // ── Aggregated metrics (rolled up across phases for top-level reads) ─────
  totals: {
    durationMs: number;
    cost: number;
    llmCalls: number;
    webSearchCalls: number;
  };

  // ── Errors (additive across phases; non-fatal warnings included) ─────────
  errors: Array<{
    phase: 'reference_resolution' | 'candidate_discovery' | 'web_research' | 'pre_filter' | 'decision';
    message: string;
    detail?: string;
    timestamp: string;
  }>;
}

SlimCandidate = {
  productId: string;
  brand: string;
  model: string;
  displayName: string;
  productCategory: { id: string; name: string };
  specs: Partial<Record<PrimarySpecKey, StructuredSpecValue>>; // primary specs only
  source: 'fuzzy' | 'embedding' | 'alias' | 'model_token' | 'web_research';
  matchScore?: number;             // when ProductMatcherService scored it
  matchComponents?: MatchComponents; // string/token/alpha/alias/spec sub-scores
  matchSpecDetails?: SpecMatchDetails;
};
```

Design notes:

- **One snapshot per phase.** Reading the trace = scanning a tree, not stitching parallel arrays. `candidateDiscovery`, `webResearch?`, `preFilter`, `decision` each carry the inputs they consumed and the outputs they produced.
- **No `anchorEntity`.** The reference product is captured as a slim `reference` object with primary-spec subset; the full `ProductModel` entity is not persisted. Web research and matcher reads of the reference go through `context.reference` instead.
- **No `originalInput` / `activeInput` distinction.** `input` is the dispatched input, immutable. There's no in-place mutation of resolution input anymore.
- **No `iterationLog`.** §1's collapse removes the agent loop; phase ordering is fixed, and each phase carries its own `durationMs` + `cost`. Loop semantics are gone, so the log is gone.
- **`SlimCandidate` only.** Candidates carry productId + the primary specs the gate cares about, not full `ProductModel`s. The §6 admonition "store slim evidence only; avoid persisting full product entities" is now structural.
- **Skipped phases are explicit.** `webResearch.skipped` and `decision.skipped` carry a reason rather than just being absent, so traces always say *why* a phase didn't run.
- **`totals` is derived but persisted.** Sum of phase costs + durations + LLM/web-call counters. Stored alongside the breakdown so dashboards and the MCP `get_cost_analysis` tool don't have to recompute.

### 8. Wire `ResolutionInputEnricher` and `ProductReferenceResolutionService` consistently

- `ResolutionInputEnricher` (in `libs/thread-processor/.../resolution-input-enricher.service.ts`) keeps populating `input.specs` as it does today (comment-mentioned + author-history specs). Its only new responsibility is the subject-switch classifier — when the comment switches subject, clear `referenceProductId` so `ProductSearchAgent` treats the input as unanchored.
- In the product-identity-first path, continue passing `threadContext` and `commentBody` from `SubtreeProcessorService` into `ProductSearchAgent`.
- Update legacy `ProductReferenceResolutionService` to pass `threadTitle`, `subreddit`, `opSummary` where available, and `commentBody` into `ProductSearchAgent`.
- Keep the instant registry same-product fast path, but route any ambiguous / spec-conflict / variant path through `ProductResolutionDecisionService`.

### 9. Drop `searchKeyword` end-to-end

The free-text search keyword the identification LLM produces is removed from every layer:

- **Identification schema** (`libs/thread-processor/src/lib/implementations/product-identity-first/schemas/subtree-identification.schema.ts`): drop the `searchKeyword` Zod field and its JSON-schema entry.
- **Identification prompt** (`libs/thread-processor/src/lib/implementations/product-identity-first/prompts/subtree-identification.prompt.ts`): drop the `searchKeyword` example output and the `searchKeywordStr` rendering of `config.promptConfig.searchKeywordInstruction`.
- **Per-category configs** (`libs/config/src/lib/categories/<slug>/config.json`): remove `searchKeywordInstruction` from every category. Add a new `searchKeywordSuffix` field on `CategoryMatchConfig` carrying the disambiguation tokens (e.g. `"monitor"`, `"ultrawide monitor"`, `"projector"`, `"IEM"` vs. `"headphones"`) the old instruction used to teach the identification LLM. `libs/database/src/lib/postgres/types/product-category-config.ts` updated to match.
- **`ProductResolutionInput`** (`libs/database/src/lib/models/product-resolution-context.ts`): drop `searchKeyword`.
- **Consumers**: `web-research.agent.ts:604-630` `buildProductKeyword` becomes the sole keyword compiler in `ProductWebResearchService` (now extended for variant queries and the suffix); `contextual-resolution.service.ts:169-170` drops the `Search keyword:` line from `ContextualResolutionAgent`'s prompt — the structured fields it already renders carry the same information.
- **Other touch sites**: `SubtreeProcessorService`, `DeferredResolutionService`, `ProductReferenceContext`, and `ProcessingTraceData` — drop the field and its trace serialization; `DebugTraceAssemblerService` for the trace UI; identification fixtures under `apps/benchmark/` updated or regenerated.

## Test Plan

- Unit-test `ProductSearchAgent`'s `effectiveMatchSpecs` overlay:
  - No `referenceProductId` → `effectiveMatchSpecs` equals `input.specs ∩ primarySpecs`.
  - `referenceProductId` set, no comment-spec overrides → `effectiveMatchSpecs` equals the reference product's specs ∩ primarySpecs (the trigger case: 34" reference, comment doesn't contradict, `effectiveMatchSpecs.screenSize === 34`).
  - `referenceProductId` set, explicit comment override ("the 39 inch version") → `effectiveMatchSpecs.screenSize === 39`, other reference specs preserved.
  - Comment override on a non-primary spec key → ignored by the gate (only primarySpecs are enforced).
- Unit-test `ResolutionInputEnricher`'s subject-switch classifier: "I switched to the LG 27GR95" with a `referenceProductId` resolved upstream → `ResolutionInputEnricher` clears `referenceProductId` so `ProductSearchAgent` doesn't inherit specs.
- Unit-test `ProductResolutionDecisionService`'s candidate pre-filter using the existing `SpecComparisonService` semantics: candidate that matches every spec in `effectiveMatchSpecs` survives the filter; candidate that violates one dimension is dropped into `filteredCandidates` with reason `match_specs`; candidate that matches via `matcherSpecHierarchies` compatible values survives; candidate with disagreeing category is dropped with reason `category`; pre-filter empties the candidate list → returns `unresolved` with `unresolvedReason='no_qualifying_candidates'` and the LLM is not invoked.
- Unit-test `ProductWebResearchService`'s deterministic keyword compiler (extended `buildProductKeyword`): unanchored mention with `brand` + `model` only → `"<brand> <model>" <suffix>`; unanchored mention with specs → adds first 1–2 spec values; anchored variant with `referenceModel` + `modelClues` → quoted `referenceModel` followed by clues + suffix; cross-market query for the same input → distinct query intent; missing brand → falls back to model + suffix. Verify the compiler reproduces every keyword shape the old identification-LLM `searchKeyword` produced for representative fixtures (Samsung G8 trigger case, MSI MPG431CQPX vs MPG341CQPX, headphones IEM vs over-ear).
- Unit-test `ProductWebResearchService`'s per-SERP model-number extraction LLM (output is per-record `modelNumbers: string[]` on each `SearchEvidence`): SERP set with one canonical model plus marketing-name aliases on different records (each record gets the model numbers that appear in its own title/description/url; the aggregate is deduped); SERP set with regional-variant SKUs across multiple records (each record carries the variants it mentions); SERP record whose text has no real SKUs (returns empty `modelNumbers` for that record but doesn't drop the record); SERP set where the only matches are predecessor families (every record returns empty); prompt-injection style SERP snippets containing fake model numbers (must not be returned). Mock the LLM in unit tests; back this with a small live-call fixture suite via `test_ai_chat`.
- Unit-test the aggregate + catalog re-search step:
  - Per-record `modelNumbers` are deduplicated across the `SearchEvidence` array; each unique SKU is looked up against the catalog under the input brand using the existing fuzzy-lookup path.
  - Catalog hits are written into `resolvedProducts` on every `SearchEvidence` record whose `modelNumbers` contained that SKU (a single SKU appearing in 5 SERPs → all 5 records carry the same `resolvedProducts` entry; a record with two SKUs that both resolve → two entries on that record).
  - Catalog misses stay in `modelNumbers` but do not produce a `resolvedProducts` entry; they are also surfaced at the top level as `webOnlyModels`.
  - `resolvedProducts.specs` contains only `primarySpecs` keys (verified against a multi-spec catalog fixture).
- Unit-test that `ProductResolutionDecisionService`'s prompt rendering includes the full `SearchEvidence` array — title, description, url, and per-record model numbers — for every resolved candidate, so the LLM has the SERP text alongside the catalog specs.
- Unit-test pre-LLM model-token extraction (the cheap regex/heuristic pass that feeds `ProductWebResearchService`'s query planning) with exact SKUs, typo-like mentions, size prefixes, regional variants, and false positives.
- Unit-test `ProductWebResearchService`'s query planning for normal, anchored variant, enriched-unanchored, no-candidate, rejected, and ambiguous cases.
- Unit-test `ProductResolutionDecisionService`'s LLM decision parsing and gates: confident select, no select, low confidence, conflicting specs, multiple plausible candidates, web-discovered model absent from catalog.
- Add `ProductSearchOrchestrator` tests with mocked collaborators (`ProductCandidateDiscoveryService`, `ProductWebResearchService`, `ProductResolutionDecisionService`) for direct catalog hit, web-discovered variant, no candidates, ambiguous candidates, anchor sibling SKU, and unresolved outcomes.
- Add regression fixtures, **including the trigger case** (Samsung G8 thread anchor `S34DG850SU`, comment "newer version… G8sd" → expected `unresolved`, not `S32DG800SU`). Plus: MSI `MPG431CQPX` vs `MPG341CQPX`, TCL size-prefix variants, regional TV model aliases.
- Run `npx nx test product-resolution` and the relevant `thread-processor` tests. Run `tsc --noEmit` for `review-collector`, `api`, and any other app importing the touched libs.

## Assumptions

- Default behavior favors precision over recall: unresolved is better than a plausible but wrong match.
- `ProductResolutionDecisionService` runs for all non-instant resolution paths, not only after web search.
- Existing fuzzy, embedding, matcher, provider, cache, alias, and product-spec services are reused, not replaced.
- Alias auto-creation happens only from `ProductResolutionDecisionService`'s alias recommendations tied to an accepted candidate.
- `ProductSearchAgent`'s `effectiveMatchSpecs` overlay is essentially free — a per-dimension overlay of `input.specs` on the reference product's specs, restricted to `primarySpecs`, computed once per resolution. The reference product is already fetched by `ProductSearchAgent` for brand/category prefill (line 74), so no extra DB hit. The only optional LLM call is `ResolutionInputEnricher`'s subject-switch classifier, and even that can be skipped when rule-based cues are confident.
