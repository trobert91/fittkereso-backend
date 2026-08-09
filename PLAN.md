# ProductSearchAgent — Implementation Plan

## 1. Problem Statement

The current `ProductResolver` is a rigid, phase-ordered pipeline with hardcoded retry strategies. Every failure mode (wrong size prefix, missing cross-market variant, ambiguous match) requires adding another phase or special-case fix. The result is a brittle waterfall that's hard to reason about:

```
initialResolve → suffixStripRetry → normalizedModelRetry → webSearchRefinement → crossMarketSearch
```

**Core issues:**
- Phases run in fixed order regardless of input characteristics
- Web search and cross-market search are bolt-on phases at the end, not integrated into candidate discovery
- Cross-market variant extraction loses the size prefix because it runs after initial resolution fails
- No feedback loop: if web search discovers the correct model name, it doesn't rerun candidate generation with that knowledge
- Matcher diagnostics (ambiguity, critical token mismatches) don't influence which search strategy to try next
- Each retry phase re-fetches candidates from scratch instead of building on previous search results

## 2. Architecture Overview

Replace the waterfall pipeline with a **stateful agent loop** that delegates to specialized sub-agents based on the current search context. Each sub-agent enriches a shared `ProductSearchContext` and the orchestrator decides the next step based on what's known.

```
ProductSearchAgent (orchestrator loop)
  │
  ├── InputEnrichmentAgent     — Brand/category resolution, input normalization
  ├── CandidateSearchAgent     — Fuzzy + embedding search, candidate pool management
  ├── CandidateMatcherAgent    — Token matching, quality gates, match evaluation
  ├── WebSearchAgent           — SERP search, product info extraction, variant discovery
  └── ResultAssemblyAgent      — Final confidence scoring, alias creation, cleanup
```

### Control Flow

```
┌─────────────────────────────────────────────────────┐
│                 ProductSearchAgent                    │
│                                                       │
│  context.status = INPUT_RECEIVED                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ Loop while status != RESOLVED | UNRESOLVED    │    │
│  │                                                │    │
│  │  INPUT_RECEIVED ──► InputEnrichmentAgent       │    │
│  │       → status: ENRICHED                       │    │
│  │                                                │    │
│  │  ENRICHED ──► CandidateSearchAgent             │    │
│  │       → status: CANDIDATES_FOUND               │    │
│  │       or: CANDIDATES_EMPTY                     │    │
│  │                                                │    │
│  │  CANDIDATES_FOUND ──► CandidateMatcherAgent    │    │
│  │       → status: MATCH_ACCEPTED                 │    │
│  │       or: MATCH_REJECTED (with reason)         │    │
│  │       or: MATCH_AMBIGUOUS                      │    │
│  │                                                │    │
│  │  MATCH_ACCEPTED ──► ResultAssemblyAgent        │    │
│  │       → status: RESOLVED                       │    │
│  │                                                │    │
│  │  CANDIDATES_EMPTY | MATCH_REJECTED |           │    │
│  │  MATCH_AMBIGUOUS                               │    │
│  │       ──► WebSearchAgent (if enabled & budget) │    │
│  │       → Adds new model names / variants to ctx │    │
│  │       → status: ENRICHED (re-enter loop)       │    │
│  │                                                │    │
│  │  No more strategies ──► ResultAssemblyAgent    │    │
│  │       → status: UNRESOLVED                     │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  Return ProductSearchResult                           │
└─────────────────────────────────────────────────────┘
```

The key insight: **WebSearchAgent feeds discoveries back into the loop** instead of being a terminal phase. When web search finds that "75QM7K" is the US name for "75C7K", it adds `75C7K` to `context.modelVariants`, sets status back to `ENRICHED`, and the CandidateSearchAgent runs again with the new knowledge.

### Maximum Iterations

The orchestrator enforces a hard cap of **3 loop iterations** (configurable via dynamic config). This prevents infinite loops and bounds cost. A typical resolution:
- Iteration 1: enrichment → search → match (direct hit) → done
- Iteration 2: enrichment → search → match fails → web search discovers variant → loop
- Iteration 3: search with variant → match → done

## 3. ProductSearchContext

The shared state object that all sub-agents read and write:

```typescript
export enum ProductSearchStatus {
  INPUT_RECEIVED = 'INPUT_RECEIVED',
  ENRICHED = 'ENRICHED',
  CANDIDATES_FOUND = 'CANDIDATES_FOUND',
  CANDIDATES_EMPTY = 'CANDIDATES_EMPTY',
  MATCH_ACCEPTED = 'MATCH_ACCEPTED',
  MATCH_REJECTED = 'MATCH_REJECTED',
  MATCH_AMBIGUOUS = 'MATCH_AMBIGUOUS',
  RESOLVED = 'RESOLVED',
  UNRESOLVED = 'UNRESOLVED',
}

export interface ProductSearchContext {
  // ─── Status ─────────────────────────────────────────
  status: ProductSearchStatus;
  iteration: number;

  // ─── Input ──────────────────────────────────────────
  /** Original input as received from extraction */
  originalInput: ProductResolutionInput;
  /** Active input (may be updated by enrichment or web search) */
  activeInput: ProductResolutionInput;
  options: ProductSearchOptions;

  // ─── Enrichment ─────────────────────────────────────
  brand?: ProductResolutionBrand;
  categories?: ProductResolutionCategory[];
  preResolvedCategories?: ProductResolutionCategory[];
  brandCorrection?: {
    originalBrand: string;
    correctedBrand: string;
  };

  // ─── Model Variants ─────────────────────────────────
  /** All known model name variants for this product (original + discovered).
   *  Each variant is tried during candidate search. Populated by:
   *  - Original input (model, displayName)
   *  - Suffix-stripped forms (e.g. "WH-1000XM5/B" → "WH-1000XM5")
   *  - Normalized forms (e.g. "MPG 341CQPX" → "MPG341CQPX")
   *  - Web search discoveries (e.g. "75C7K" for "75QM7K")
   *  - Cross-market variants (e.g. "QE65S95B" for "QN65S95B")
   */
  modelVariants: ModelVariant[];

  // ─── Candidates ─────────────────────────────────────
  /** Deduplicated candidate pool built across all search iterations */
  candidates: EvaluatedProduct[];
  candidateFunnel?: CandidateFunnel;

  // ─── Match ──────────────────────────────────────────
  matchOutcome?: {
    resolvedModel?: ProductModel;
    matchResult?: MatchResult;
    diagnostics?: MatchDiagnostics;
    rejected?: boolean;
    rejectionReason?: string;
  };

  // ─── Web Search ─────────────────────────────────────
  webSearchAttempts: WebSearchAttempt[];
  /** Budget tracking: how many web searches have been performed */
  webSearchCount: number;

  // ─── Tracing ────────────────────────────────────────
  phaseTimings: Record<string, number>;
  /** Per-iteration log of which agents ran and what they decided */
  iterationLog: IterationLogEntry[];
}

export interface ModelVariant {
  model: string;
  displayName?: string;
  source: 'original' | 'suffix_strip' | 'normalization' | 'web_search' | 'cross_market';
  region?: string;
  /** Whether this variant has been searched for candidates already */
  searched: boolean;
}

export interface WebSearchAttempt {
  keyword: string;
  provider?: 'dataforseo' | 'exa';
  source?: 'cache' | 'api';
  cacheHit?: boolean;
  cacheEntryId?: string;
  serpResultCount?: number;
  /** What the search discovered */
  discoveredVariants?: ModelVariant[];
  discoveredSpecs?: string[];
  refinedInput?: Partial<ProductResolutionInput>;
  /** What triggered this search */
  trigger: 'no_candidates' | 'match_rejected' | 'match_ambiguous' | 'cross_market';
}

export interface CandidateFunnel {
  fuzzyCount: number;
  embeddingCount: number;
  totalBeforeDedupe: number;
  totalAfterDedupe: number;
}

export interface IterationLogEntry {
  iteration: number;
  agents: string[];
  statusBefore: ProductSearchStatus;
  statusAfter: ProductSearchStatus;
  durationMs: number;
}
```

## 4. Sub-Agent Specifications

### 4.1 InputEnrichmentAgent

**Responsibility:** Prepare input for candidate search — resolve brand, match categories, generate model variants from the raw input, apply brand correction rules.

**Triggers on status:** `INPUT_RECEIVED`

**Sets status to:** `ENRICHED`

**Logic:**
1. Apply brand correction rules (AW→Dell, ROG→ASUS, extensible via config)
2. Resolve brand via `BrandResolutionService` (trigram similarity)
3. Resolve categories via `CategoryNameMatcherService` (or use preResolvedCategories)
4. Generate model variants from original input:
   - **Original**: `{ model: "75QM7K", source: "original" }`
   - **Suffix-stripped**: `{ model: "75QM7", source: "suffix_strip" }` (if trailing `[-/][a-z]`)
   - **Normalized**: `{ model: "75QM7K", source: "normalization" }` (collapse letter/digit spaces)
   - **Brand-stripped**: If model starts with brand name, strip it

**Reuses:**
- `BrandResolutionService` (as-is)
- `CategoryNameMatcherService` (as-is)

**New code:**
- `InputEnrichmentAgent` class (~100 lines)
- Model variant generation logic (extracted from current suffix-strip + normalization phases)

### 4.2 CandidateSearchAgent

**Responsibility:** Build the candidate pool by searching for ALL unsearched model variants via fuzzy and embedding search. Merges results into `context.candidates`, deduplicating by product ID.

**Triggers on status:** `ENRICHED`

**Sets status to:** `CANDIDATES_FOUND` or `CANDIDATES_EMPTY`

**Logic:**
1. Filter `context.modelVariants` to those with `searched: false`
2. For each unsearched variant, in parallel:
   a. Build a `ProductResolutionInput` from the variant
   b. Run fuzzy search (always)
   c. Run embedding search (if `options.useEmbedding`)
3. Mark variants as `searched: true`
4. Merge new candidates into `context.candidates` (deduplicate by ID, keep highest confidence)
5. Update `context.candidateFunnel`
6. If `context.candidates` is empty after all variants tried → `CANDIDATES_EMPTY`
7. Otherwise → `CANDIDATES_FOUND`

**Key improvement over current system:** Searches for ALL known model variants in a single pass. When web search discovers "75C7K" as a variant of "75QM7K", re-entering the loop causes this agent to search specifically for "75C7K" candidates — without re-searching the already-tried variants.

**Reuses:**
- `ProductFuzzySearchService` (as-is)
- `ProductEmbeddingMatchService` (as-is)

**New code:**
- `CandidateSearchAgent` class (~120 lines)

### 4.3 CandidateMatcherAgent

**Responsibility:** Evaluate the candidate pool against the active input. Determine if there's a confident match, an ambiguous match, or no match.

**Triggers on status:** `CANDIDATES_FOUND`

**Sets status to:** `MATCH_ACCEPTED`, `MATCH_REJECTED`, or `MATCH_AMBIGUOUS`

**Logic:**
1. Try matching against the **active input** first (the most complete/refined input)
2. If that fails (rejected/ambiguous), try matching against each **unsearched model variant** as input (different tokenization may produce different match outcomes)
3. Store best `matchOutcome` on context, including full `MatchDiagnostics`
4. Set status based on outcome:
   - `outcome.rejected` with `failedGates` containing `ambiguous_match` → `MATCH_AMBIGUOUS`
   - `outcome.rejected` with other gates → `MATCH_REJECTED`
   - Otherwise → `MATCH_ACCEPTED`

**Reuses:**
- `ProductMatcherService.evaluateCandidates()` (as-is, with MatchDiagnostics)

**New code:**
- `CandidateMatcherAgent` class (~80 lines)
- Thin wrapper that interprets MatchOutcome into agent status transitions

### 4.4 WebSearchAgent

**Responsibility:** Use web search to discover the correct product name, find cross-market variants, and gather specs. This is the most complex agent — it combines the current `refineInputWithWebSearch` and `crossMarketSearch` phases into a single intelligent agent.

**Triggers on status:** `CANDIDATES_EMPTY`, `MATCH_REJECTED`, or `MATCH_AMBIGUOUS`

**Sets status to:** `ENRICHED` (to re-enter the loop) or leaves status unchanged (no new info found)

**Budget:** Maximum 2 web search API calls per resolution (configurable). Tracks via `context.webSearchCount`.

**Logic — three strategies chosen based on trigger:**

#### Strategy A: Product Info Search (trigger: `CANDIDATES_EMPTY` or `MATCH_REJECTED`)
When we have no candidates or the match was rejected, we need to find out what this product actually is.

1. Build search keyword from `activeInput` (brand + model + category)
2. Call `ProductWebSearchService.search()`
3. Extract product info via `ProductSerpExtractorService.extractInfoFromSerpResults()`
4. If extraction yields a different/more specific model name:
   - Add as `ModelVariant` with `source: 'web_search'`
   - Update `context.activeInput` with refined brand/model/displayName
5. If SERP results mention other market variants:
   - Parse variant names from titles/descriptions (or use LLM extraction)
   - Add each as `ModelVariant` with `source: 'cross_market'`
   - Prepend original size prefix to bare variants (solving the C7K→75C7K problem)
6. Record attempt in `context.webSearchAttempts`
7. Set status to `ENRICHED` if any new variants were discovered

#### Strategy B: Disambiguation Search (trigger: `MATCH_AMBIGUOUS`)
When two candidates score too close, we need more information to distinguish them.

1. Build a targeted keyword: `"Brand Model1" vs "Brand Model2" difference specs`
2. Search and extract — focus on differentiating specs (screen size, panel type, etc.)
3. If disambiguation discovers that one candidate is the correct product:
   - Add its exact model name as a high-priority variant
   - Update activeInput specs if new specs were found
4. Set status to `ENRICHED`

#### Strategy C: Cross-Market Search (runs alongside A when market variants suspected)
When the model name pattern suggests it might be a regional variant (letters preceding digits differ from DB patterns), also:

1. Search for `"Brand Model" equivalent model regional variant`
2. Extract variants via LLM (same as current `extractVariantsFromSerp`)
3. Prepend size prefix to bare variants
4. Add as `ModelVariant` entries with `source: 'cross_market'` and `region`

**Key improvement:** Strategies A and C can be combined into a single web search call when both are needed. The SERP results are parsed for both product info refinement AND cross-market variants in one pass.

**Reuses:**
- `ProductWebSearchService` (as-is)
- `ProductSerpExtractorService` (as-is)
- Cross-market LLM extraction logic (extracted from `ProductCrossMarketSearchService`)

**New code:**
- `WebSearchAgent` class (~250 lines)
- Combined SERP parsing for product info + variants
- Disambiguation search strategy
- Size prefix prepending (moved from resolver)

### 4.5 ResultAssemblyAgent

**Responsibility:** Finalize the result — set resolved product, create aliases for discovered variants, clean up context for storage.

**Triggers on status:** `MATCH_ACCEPTED` (→ `RESOLVED`) or end of loop (→ `UNRESOLVED`)

**Logic (RESOLVED path):**
1. Set `resolvedModel` from `matchOutcome`
2. Enrich winning candidate with match scoring details
3. Auto-create aliases for discovered cross-market variants via `ProductAliasAutoCreateService`
4. Record `resolvedPhase` equivalent (which iteration + which variant resolved it)
5. Clean up candidates (remove internal fields like specs, category)
6. Set status to `RESOLVED`

**Logic (UNRESOLVED path):**
1. Log missed match with top candidates
2. Clean up context
3. Set status to `UNRESOLVED`

**Reuses:**
- `ProductAliasAutoCreateService` (as-is)

**New code:**
- `ResultAssemblyAgent` class (~80 lines)

## 5. ProductSearchAgent (Orchestrator)

```typescript
@Injectable()
export class ProductSearchAgent {
  constructor(
    private readonly inputEnrichment: InputEnrichmentAgent,
    private readonly candidateSearch: CandidateSearchAgent,
    private readonly candidateMatcher: CandidateMatcherAgent,
    private readonly webSearch: WebSearchAgent,
    private readonly resultAssembly: ResultAssemblyAgent,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  async search(
    input: ProductResolutionInput,
    options: ProductSearchOptions,
    logContext?: Record<string, string>,
    traceCollector?: (data: ChatTraceData) => void,
  ): Promise<ProductSearchResult> {
    const config = await this.dynamicConfigService.getConfig();
    const maxIterations = config.search?.maxIterations ?? 3;

    const context = this.buildInitialContext(input, options);

    while (context.iteration < maxIterations) {
      context.iteration++;
      const iterationStart = Date.now();

      switch (context.status) {
        case ProductSearchStatus.INPUT_RECEIVED:
        case ProductSearchStatus.ENRICHED:
          // These two both need candidate search, but INPUT_RECEIVED
          // needs enrichment first
          if (context.status === ProductSearchStatus.INPUT_RECEIVED) {
            await this.inputEnrichment.execute(context, logContext);
          }
          await this.candidateSearch.execute(context, logContext);
          break;

        case ProductSearchStatus.CANDIDATES_FOUND:
          await this.candidateMatcher.execute(context, logContext);
          break;

        case ProductSearchStatus.MATCH_ACCEPTED:
          await this.resultAssembly.execute(context, logContext);
          return this.buildResult(context);

        case ProductSearchStatus.CANDIDATES_EMPTY:
        case ProductSearchStatus.MATCH_REJECTED:
        case ProductSearchStatus.MATCH_AMBIGUOUS:
          if (this.canAttemptWebSearch(context, options)) {
            await this.webSearch.execute(context, logContext, traceCollector);
            // If web search didn't discover anything new, break the loop
            if (context.status !== ProductSearchStatus.ENRICHED) {
              break;
            }
            continue; // Re-enter loop with new knowledge
          }
          break;

        case ProductSearchStatus.RESOLVED:
        case ProductSearchStatus.UNRESOLVED:
          return this.buildResult(context);
      }

      // Record iteration log
      context.iterationLog.push({ ... });

      // If status hasn't changed to something actionable, we're done
      if (this.isTerminalStatus(context.status) ||
          !this.hasNewWork(context)) {
        break;
      }
    }

    // Exhausted iterations without resolution
    await this.resultAssembly.execute(context, logContext);
    return this.buildResult(context);
  }
}
```

## 6. ProductSearchResult (Output Type)

```typescript
export interface ProductSearchResult {
  /** The resolved product, if found */
  resolvedModel?: ProductModel;

  /** Full search context for debugging/tracing (stored as JSONB on ProductReference) */
  context: ProductSearchContext;
}
```

The `ProductSearchContext` replaces `ProductResolutionContext` as the JSONB stored on `ProductReference.context`. It contains all the same diagnostic data plus richer tracing (iteration log, web search attempts, model variants).

## 7. File Structure

```
libs/product-resolution/src/lib/
├── services/                          # Existing services (unchanged)
│   ├── product-resolution.service.ts  # Keep for backward compat (delegates to agent)
│   ├── product-matcher.service.ts     # Reused by CandidateMatcherAgent
│   ├── product-fuzzy-search.service.ts
│   ├── product-embedding-match.service.ts
│   ├── product-web-search.service.ts
│   ├── product-serp-extractor.service.ts
│   ├── brand-resolution.service.ts
│   ├── category-name-matcher.service.ts
│   ├── product-alias-auto-create.service.ts
│   ├── matching-config.service.ts
│   └── ...
│
├── search-agent/                      # New folder
│   ├── product-search-agent.service.ts        # Orchestrator
│   ├── agents/
│   │   ├── input-enrichment.agent.ts          # Brand/category/variant generation
│   │   ├── candidate-search.agent.ts          # Fuzzy + embedding search
│   │   ├── candidate-matcher.agent.ts         # Token matching + quality gates
│   │   ├── web-search.agent.ts                # SERP search + variant discovery
│   │   └── result-assembly.agent.ts           # Finalization + alias creation
│   ├── models/
│   │   ├── product-search-context.ts          # Context, status enum, all interfaces
│   │   └── product-search-options.ts          # Input options
│   └── index.ts                               # Barrel export
```

## 8. Migration Strategy

### Phase 1: Build the agent alongside existing code
- Create the `search-agent/` folder with all new files
- `ProductSearchAgent` uses existing services via DI (no duplication)
- Add `ProductSearchAgent` to `ProductResolutionModule` providers and exports
- Add test controller endpoint for the new agent

### Phase 2: Wire up the new agent
- Update `ProductReferenceResolutionService` to use `ProductSearchAgent.search()` instead of `ProductResolutionService.resolve()`
- Map `ProductSearchOptions` from the existing resolution options
- The `ProductSearchContext` gets stored on `ProductReference.context` (JSONB column, no migration needed — just a different shape)

### Phase 3: Remove old code
- Once validated in production, remove `ProductResolver` / `ProductResolutionSession`
- Keep `ProductResolutionService` as a thin wrapper if needed for backward compat
- Remove `ProductCrossMarketSearchService` (logic absorbed into `WebSearchAgent`)
- Remove `ProductSearchRelevanceCalculatorService` (web search evaluation absorbed into `WebSearchAgent`)

## 9. How This Solves Previous Issues

### TCL 75C7K → 85C7K (wrong size)
- `CandidateMatcherAgent` uses the `critical_numeric_mismatch` gate (already implemented)
- Status becomes `MATCH_REJECTED`
- `WebSearchAgent` searches for the product, discovers it's a TCL C7K series
- If the product doesn't exist in DB, status stays `UNRESOLVED` (correct behavior — we shouldn't resolve to a wrong-size product)

### TCL 75QM7K → not resolved (cross-market variant not found)
- Initial search finds `85C7K` and `75C7K` as candidates — `MATCH_AMBIGUOUS`
- `WebSearchAgent` discovers `75QM7K` ↔ `75C7K` (US↔EU variant)
- Adds `{ model: "75C7K", source: "cross_market" }` to `modelVariants`
- Sets status to `ENRICHED` → `CandidateSearchAgent` searches for `75C7K`
- `CandidateMatcherAgent` now has `75C7K` as a candidate matching `75C7K` from cross-market → perfect match
- `ResultAssemblyAgent` auto-creates alias `75QM7K` on the resolved product

### TCL 85QM7K → TCL 24G54 (tokenizer bug, now fixed + bypass)
- Fixed tokenizer (`/[a-z]+|\d+/`) produces correct critical alpha tokens
- `CandidateMatcherAgent` bypass check catches alpha mismatch
- Even without bypass, `critical_numeric_mismatch` gate rejects wrong candidates

### Size prefix loss in cross-market variants
- `WebSearchAgent` handles size prefix prepending internally when it discovers bare variants
- `ModelVariant` stores the full model name (e.g., `75C7K` not `C7K`)
- No information loss between web search and candidate search

### Web search evaluator skipping useful searches
- `WebSearchAgent` decides based on the actual failure reason, not a generic evaluator
- `CANDIDATES_EMPTY` always triggers web search (if enabled + budget remaining)
- `MATCH_AMBIGUOUS` triggers disambiguation search with targeted keywords

## 10. Implementation Order

1. **`models/product-search-context.ts`** — Status enum, context interface, all sub-interfaces
2. **`models/product-search-options.ts`** — Options interface
3. **`agents/input-enrichment.agent.ts`** — Extract logic from `enrichContext` + `applyBrandCorrection` + variant generation
4. **`agents/candidate-search.agent.ts`** — Multi-variant search wrapping fuzzy + embedding
5. **`agents/candidate-matcher.agent.ts`** — Thin wrapper around `ProductMatcherService`
6. **`agents/web-search.agent.ts`** — Combine web search + cross-market + SERP extraction
7. **`agents/result-assembly.agent.ts`** — Finalization + alias creation
8. **`product-search-agent.service.ts`** — Orchestrator loop
9. **Test controller endpoint** — For manual testing
10. **Wire into pipeline** — Replace `ProductResolutionService` calls
