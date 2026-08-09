# Product Search — Current Architecture Map

This document maps the current product-resolution pipeline as it is wired today. It is built as the baseline for a future refactor, simplification, and optimization pass.

All paths below are relative to `ebike-backend/`.

---

## 1. The entry point and what calls it

### 1.1 Who calls the search

The orchestrator is invoked **per `ProductReference`** by the subtree processor:

- [libs/thread-processor/src/lib/implementations/product-identity-first/services/subtree-processor.service.ts](libs/thread-processor/src/lib/implementations/product-identity-first/services/subtree-processor.service.ts)

Resolution runs after extraction. For every `ProductReference` on every comment in a subtree, the processor:

1. **Enriches the identification input** via `ResolutionInputEnricher` (pulls extra specs from descendants/ancestors/author affinity in the thread).
2. **Decides the routing path** based on the anchor relation to a known catalog product (see §3 below). The anchor comes from `referenceProductId` resolved upstream by the enricher when the identification LLM emitted a cheat-sheet `referenceModel`.
3. **Picks search options** (web search on/off, mode strict/loose, pre-resolved categories, thread context for the decision LLM).
4. **Calls `ProductSearchOrchestrator.search(input, options, logContext, traceCollector)`** — see [libs/product-resolution/src/lib/search-agent/product-search-orchestrator.service.ts](libs/product-resolution/src/lib/search-agent/product-search-orchestrator.service.ts).
5. **Writes the result back to the reference** as `ref.resolvedModel`, `ref.resolutionConfidence`, `ref.searchContext` (full persisted `ProductSearchContext` — this is what the JSON reference dumps show).

Two short-circuit paths skip the orchestrator entirely:

- **Path 0 — anchor "same"**: the comment refers back to a cheat-sheet anchor without spec divergence ⇒ instant resolve to the anchor, no search.
- **Registry instant resolve**: the unified registry (brand+model key) already holds a resolved product and the new mention adds no extra specs ⇒ reuse, no search.

A `withRegistryKeyLock` ensures the first thread that resolves a registry key wins and others reuse.

### 1.2 The input

`ProductResolutionInput` — see [libs/database/src/lib/models/product-resolution-context.ts](libs/database/src/lib/models/product-resolution-context.ts) — is the only signal the orchestrator gets. Fields:

| Field                                  | Source                                                   | Purpose                                       |
| -------------------------------------- | -------------------------------------------------------- | --------------------------------------------- | -------------- | --------------------------------------------------- |
| `brand`, `model`, `displayName`        | LLM identification                                       | Primary search keys                           |
| `specs: StructuredSpec[]`              | Identification + enricher (descendants/ancestors/author) | Spec gate, query enrichment                   |
| `categories: string[]`, `categoryHint` | Identification                                           | Category resolution + pre-filter              |
| `searchBefore: Date`                   | Comment timestamp                                        | Temporal cutoff for web search                |
| `releaseYear`                          | Scraper (rare)                                           | Scoring adjustment                            |
| `referenceProductId`                   | Enricher (resolved from cheat-sheet `referenceModel`)    | Anchored routing                              |
| `referenceModel`                       | Identification (verbatim cheat-sheet token)              | Anchored query / enriched-unanchored fallback |
| `modelClues: string[]`                 | Identification                                           | Disambiguating fragments for SERP queries     |
| `variantClues: string[]`               | Identification                                           | Free-form variant traits for SERP queries     |
| `registryKey`                          | Identification                                           | `brand::model` key for cross-thread reuse     |
| `contentQuality: 'high'                | 'medium'                                                 | 'low'`                                        | Identification | Web-search gating (only "high" + OP get web search) |
| `abbreviations: string[]`              | Identification                                           | (Not heavily used downstream)                 |

`ProductSearchOptions`:

```ts
{
  useEmbedding: boolean,
  webSearchEnabled: boolean,
  mode: 'strict' | 'loose',
  preResolvedCategories?: ProductResolutionCategory[],
  threadContext?: {
    threadTitle, subreddit, opSummary?, resolvedProducts?: string[],
    commentBody?: string  // present for the decision LLM
  }
}
```

### 1.3 The output

`ProductSearchResult`:

```ts
{
  resolvedModel?: ProductModel,   // full TypeORM entity when MATCH_ACCEPTED
  context: ProductSearchContext   // the persisted snapshot the JSON dumps show
}
```

`ProductSearchContext` ([libs/database/src/lib/models/product-search-context.ts](libs/database/src/lib/models/product-search-context.ts)) is both the **working scratchpad during search** (mutable, agents push into it) and the **persisted artifact stored on the reference** (sliced/normalized by the result builder).

The context has two faces:

- **§7 phase-aligned shape** (canonical): `input`, `options`, `reference`, `effectiveMatchSpecs`, `candidateDiscovery`, `webResearch`, `preFilter`, `decision`, `status`, `resolvedProduct`, `totals`, `phaseErrors`.
- **Legacy transient state** (`@deprecated WI 9`): `originalInput`, `activeInput`, `modelVariants`, `searchedKeywords`, `candidates: EvaluatedProduct[]`, `candidateFunnel`, `matchOutcome`, `anchorEntity`, `searchEvidence`, `webOnlyModels`, `webSearchAttempts`, `crossMarketRanking`, `phaseTimings`, `iterationLog`, `errors`, `contextualResolution`. These are still actively used during a run — both faces coexist on the same object.

`status` flows through: `INPUT_RECEIVED → ENRICHED → CANDIDATES_FOUND|CANDIDATES_EMPTY → MATCH_ACCEPTED|MATCH_REJECTED|MATCH_AMBIGUOUS → RESOLVED|UNRESOLVED`.

---

## 2. Service inventory

The product-resolution library has ~25 services. Below is the actual wiring (from [product-resolution.module.ts](libs/product-resolution/src/lib/product-resolution.module.ts)).

### 2.1 Orchestration

| Service                                                                                                             | File            | Role                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ProductSearchOrchestrator](libs/product-resolution/src/lib/search-agent/product-search-orchestrator.service.ts)    | `search-agent/` | Owns the fixed phase ordering. Public entry point.                                                                                                                              |
| [ProductSearchResultBuilder](libs/product-resolution/src/lib/search-agent/product-search-result-builder.service.ts) | `search-agent/` | Pure mapping from final context → `ProductSearchResult`. Populates the §7 phase-aligned fields, strips the full `ProductModel` entity, synthesizes the final `decision.result`. |

### 2.2 Phase 1 — Discovery

| Service                                                                                                             | File        | Role                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ProductCandidateDiscoveryService](libs/product-resolution/src/lib/services/product-candidate-discovery.service.ts) | `services/` | Owns brand+category enrichment, model-variant generation, candidate search invocation, and matcher invocation.                                                                                                                                                 |
| [BrandResolutionService](libs/product-resolution/src/lib/services/brand-resolution.service.ts)                      | `services/` | Trigram-similarity DB lookup for brand.                                                                                                                                                                                                                        |
| [CategoryNameMatcherService](libs/product-resolution/src/lib/services/category-name-matcher.service.ts)             | `services/` | Matches extracted category hints against enabled categories.                                                                                                                                                                                                   |
| [InputNormalizationService](libs/product-resolution/src/lib/services/input-normalization.service.ts)                | `services/` | Per-category match config (strictness, numericTokenRules, primarySpecs, matcherSpecs, hierarchies). Normalizes the model string (brand strip + basic normalization), parses into tokens (numeric/alpha/critical/suffix).                                       |
| [MatchingConfigService](libs/product-resolution/src/lib/services/matching-config.service.ts)                        | `services/` | Loads `resolution.json` thresholds (`acceptThreshold`, `acceptThresholdStrict`, `ambiguityGap`, `ambiguityGapAnchored`, default strictness/weights). Anchored mode uses the unified `acceptThreshold`; its extra strictness comes from `ambiguityGapAnchored`. |

### 2.3 Phase 1.5 — Candidate search

| Service                                                                                                     | File                   | Role                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [CandidateSearchAgent](libs/product-resolution/src/lib/search-agent/agents/candidate-search.agent.ts)       | `search-agent/agents/` | Runs fuzzy search per unsearched model variant in parallel; runs embedding search **only when fuzzy finds zero hits** and `useEmbedding` is enabled. Dedupes, caps to `maxCandidates`, excludes `referenceProductId`, sets `candidateFunnel`.          |
| [ProductFuzzySearchService](libs/product-resolution/src/lib/services/product-fuzzy-search.service.ts)       | `services/`            | Postgres trigram (`similarity`) over `normalizedName`, `alias`, `model`. Hard threshold 0.4, top 5, scoped by `brandId` and `categoryIds` when present.                                                                                                |
| [ProductEmbeddingMatchService](libs/product-resolution/src/lib/services/product-embedding-match.service.ts) | `services/`            | pgvector cosine search via two-phase query (IDs first, then full entities). Uses `ProductEmbeddingService` to build the mention embedding from `brand+model+displayName+category`. Threshold + limit from `ResolutionConfigService` (default 0.4 / 5). |

### 2.4 Phase 1.5b — Matching

| Service                                                                                                              | File        | Role                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ProductMatcherService](libs/product-resolution/src/lib/services/product-matcher.service.ts)                         | `services/` | Strict-mode spec pre-filter → dedupe by id → score every candidate → quality-gate the best vs. second → auto-create alias on high-confidence hit.                                                       |
| [CandidateScoringService](libs/product-resolution/src/lib/services/candidate-scoring.service.ts)                     | `services/` | Thin wrapper around `ProductSimilarityService` (in `@ebike-backend/product`). Produces `MatchResult` with components: `stringSimilarity`, `tokenOverlap`, `alphaMatch`, `aliasMatch`, `specSimilarity`. |
| [ProductMatcherQualityGateService](libs/product-resolution/src/lib/services/product-matcher-quality-gate.service.ts) | `services/` | Gate ladder (see §6). `evaluate` for normal, `evaluateAnchored` for anchored mode (stricter floor + wider ambiguity gap).                                                                               |
| [ProductAliasAutoCreateService](libs/product-resolution/src/lib/services/product-alias-auto-create.service.ts)       | `services/` | Persists aliases from web-discovered model variants when resolution succeeds (gated by `resolution.aliasAutoCreate.enabled`, default false in current config).                                          |

### 2.5 Phase 2 — Web research

| Service                                                                                                                | File                     | Role                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WebResearchAgent](libs/product-resolution/src/lib/search-agent/agents/web-research.agent.ts)                          | `search-agent/agents/`   | Three-way strategy router (anchored / enriched-unanchored / combined). Owns the SERP-extraction → catalog-research → re-seed loop and the cross-market direct-match ranker.                                                |
| [WebResearchKeywordService](libs/product-resolution/src/lib/services/web-research-keyword.service.ts)                  | `services/`              | Deterministic keyword compiler. Four builders: `buildExactModelQuery`, `buildModelWithSpecsQuery`, `buildSiblingSkuQuery`, `buildCrossMarketQuery`. Pulls per-category `searchKeywordSuffix` from `CategoryConfigService`. |
| [ProductWebSearchService](libs/product-resolution/src/lib/services/product-web-search.service.ts)                      | `services/`              | Cache-first SERP fetch with provider selection (Exa vs DataForSEO). Records to `WebSearchCacheRepository` (Postgres trigram on keyword + date tolerance).                                                                  |
| [WebSearchExtractionService](libs/product-resolution/src/lib/search-agent/services/web-search-extraction.service.ts)   | `search-agent/services/` | **LLM #1** in web research: extracts the product+regional variants from combined SERP results (legacy path that feeds back into `modelVariants` for re-search). Also hosts the cross-market candidate ranker LLM.          |
| [WebResearchSerpExtractionService](libs/product-resolution/src/lib/services/web-research-serp-extraction.service.ts)   | `services/`              | **LLM #2** in web research: per-record SKU extraction. Builds `SearchEvidence[]` with `modelNumbers` for each SERP record.                                                                                                 |
| [WebResearchCatalogResearchService](libs/product-resolution/src/lib/services/web-research-catalog-research.service.ts) | `services/`              | For every extracted model number, fuzzy-searches the catalog under the input brand to convert SKUs into candidate `EvaluatedProduct` rows. Writes `resolvedProducts` back onto each `SearchEvidence` record.               |

### 2.6 Phase 3 — Pre-filter, Phase 4 — Decision

| Service                                                                                                             | File        | Role                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| [CandidatePreFilterService](libs/product-resolution/src/lib/services/candidate-pre-filter.service.ts)               | `services/` | Drops candidates that violate `effectiveMatchSpecs` (primary-spec mismatch) or the effective category constraint.                                                  |
| [ProductResolutionDecisionService](libs/product-resolution/src/lib/services/product-resolution-decision.service.ts) | `services/` | **LLM #3** in web-research-bearing runs: final disambiguator. Takes qualifying candidates + matcher evidence + SERP evidence + thread context, returns `'resolved' | 'unresolved'` with confidence. |

### 2.7 Utilities

| Module                  | File                                                                                                                                         | Role                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `effective-match-specs` | [libs/product-resolution/src/lib/utils/effective-match-specs.ts](libs/product-resolution/src/lib/utils/effective-match-specs.ts)             | `pickPrimarySpecs(specs, primarySpecs)` and `computeEffectiveMatchSpecs(refSpecs, inputSpecs, primarySpecs)` — input wins where both present. |
| `spec-utils`            | [libs/product-resolution/src/lib/utils/spec-utils.ts](libs/product-resolution/src/lib/utils/spec-utils.ts)                                   | `structuredSpecsToProductSpecs`, `isSpecsEmpty`, `productSpecsSummary`.                                                                       |
| `with-one-retry`        | [libs/product-resolution/src/lib/search-agent/utils/with-one-retry.ts](libs/product-resolution/src/lib/search-agent/utils/with-one-retry.ts) | Single retry wrapper around fragile calls.                                                                                                    |

---

## 3. Routing — how a reference gets to the orchestrator

Decided in `resolveProductReferences` of [subtree-processor.service.ts](libs/thread-processor/src/lib/implementations/product-identity-first/services/subtree-processor.service.ts):

```
                    ┌─ resolutionDeferred? ─ skip
ProductReference ───┤
                    ├─ Enricher merges descendant/ancestor/author specs
                    ├─ web-search gating (contentQuality + OP + clues)
                    └─ Anchor relation:
                           ┌─ 'same'    ─ Path 0: instant resolve to anchor (no orchestrator call)
                           ├─ 'variant' ─ Path 1: orchestrator with referenceProductId, webSearch ON, loose
                           └─ 'none'    ─ fall through:
                                ┌─ registry hit + no specs       ─ instant resolve (no call)
                                ├─ registry hit + own specs      ─ Path: variant input (anchor=registry product) → orchestrator
                                ├─ hasSpecs or no registryKey    ─ Path: full search → orchestrator
                                └─ else (no specs, has registryKey) ─ Path: locked search → orchestrator + write registry
```

So the orchestrator is called in **4 distinct shapes**:

1. **Anchored variant** (Path 1): `input.referenceProductId` set → orchestrator runs `runAnchoredDiscoveryPhase` (skips brand/category enrichment, pre-populates everything from the anchor entity).
2. **Registry variant**: `input` rebuilt around the registry product as a pseudo-anchor.
3. **Full search**: `enrichedInput` passed straight through, full discovery.
4. **Locked first-resolve**: same as full, but inside a registry-key mutex.

All four eventually go through the same orchestrator phases below; the anchored path skips the discovery enrichment step.

---

## 4. The orchestrator's phase ordering

`ProductSearchOrchestrator.search()`:

```
buildInitialContext(input, options)
    │
    ▼
[Phase 1] runAnchoredDiscoveryPhase (only if input.referenceProductId)
    │     ├─ load anchor entity (full ProductModel)
    │     ├─ set brand, categories, reference (SlimReference), effectiveMatchSpecs from anchor
    │     ├─ seed modelVariants = [anchor.model, ...input.modelClues]
    │     ├─ status = ENRICHED
    │     └─ runSearchAndMatch (candidate search + pre-filter + matcher)
    │
    │ OR
    │
[Phase 1'] candidateDiscovery.discover(context)
          ├─ enrich():
          │   ├─ BrandResolutionService.resolve  → context.brand
          │   ├─ CategoryNameMatcherService.matchFromEnabledCategories (per hint)
          │   │   (skipped when options.preResolvedCategories is set)
          │   ├─ buildModelVariants: model + suffix_strip + normalization + brand_strip
          │   │     + referenceModel + modelClues (deduped, capped to maxModelVariants=20)
          │   └─ status = ENRICHED
          ├─ CandidateSearchAgent.execute (fuzzy primary, embedding fallback)
          └─ match (matcher + quality gate)
    ▼
[Phase 2] runWebResearchLoop:
    │     while true:
    │       ├─ if MATCH_ACCEPTED with zero web attempts → 'finalize-accepted', skip decision LLM
    │       ├─ if MATCH_ACCEPTED with prior web attempts → 'continue' (loop ends, run decision)
    │       ├─ if status in {CANDIDATES_EMPTY, MATCH_REJECTED, MATCH_AMBIGUOUS} and webSearchEnabled:
    │       │   └─ WebResearchAgent.execute (see §5)
    │       └─ if status != ENRICHED after web research → break
    │       └─ runSearchAndMatch (new variants discovered → re-run search + match)
    ▼
[Phase 3] runFinalDecisionPhase (only if threadContext present AND ≥1 qualifying candidate)
    │     ├─ Build SlimCandidate list from current context.candidates
    │     ├─ Build matcher evidence per candidate (score + failed gates)
    │     └─ ProductResolutionDecisionService.decide → 'resolved'|'unresolved'
    │         + sets contextualResolution + status = MATCH_ACCEPTED on resolved
    ▼
[Phase 4] finalize:
    │     ├─ if MATCH_ACCEPTED → run aliasAutoCreate (when enabled); status = RESOLVED
    │     └─ else status = UNRESOLVED
    ▼
ProductSearchResultBuilder.build(context)
    └─ Maps legacy transient state into §7 phase-aligned shape; returns the result
```

### 4.1 The "runSearchAndMatch" inner step

Called from both the anchored path and the web-research loop:

```
candidateSearch.execute    → context.candidates (deduped), status = CANDIDATES_FOUND|CANDIDATES_EMPTY
   │
   ▼
applyPreFilter (if CANDIDATES_FOUND)
   │  ├─ effectiveCategoryName from reference.productCategory or activeInput.categoryHint
   │  ├─ CandidatePreFilterService.filter:
   │  │    ├─ category gate (case-insensitive name compare)
   │  │    └─ spec gate (SpecComparisonService against effectiveMatchSpecs / primarySpecs)
   │  └─ if 0 survivors → status = CANDIDATES_EMPTY
   │
   ▼
candidateDiscovery.matchCandidates (if still CANDIDATES_FOUND)
   └─ ProductMatcherService.evaluateCandidates per variant input
       (tries original input, then activeInput, then per-variant) — first acceptance wins
```

---

## 5. The web-research subsystem in detail

This is the most complex piece. Lives in `WebResearchAgent` ([web-research.agent.ts](libs/product-resolution/src/lib/search-agent/agents/web-research.agent.ts)) and its collaborators.

### 5.1 Three-way strategy branch

Decided at the top of `runCombinedResearchStrategy`:

| Condition                                                                   | Strategy                | What runs                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.anchorEntity` set (Path 1)                                         | **Anchored**            | One `buildSiblingSkuQuery` SERP → legacy product extraction (with anchor-aware system prompt) → SERP-evidence pipeline → re-seed modelVariants. **No cross-market**.                                                  |
| `hasUnanchoredSignals` (referenceModel / modelClues / variantClues present) | **Enriched-unanchored** | One `buildSiblingSkuQuery` SERP → legacy extraction → SERP-evidence pipeline → cross-market ranker → re-seed.                                                                                                         |
| Otherwise                                                                   | **Combined**            | Two parallel SERP fetches: `buildModelWithSpecsQuery` + `buildCrossMarketQuery`. Both feed the legacy extraction (single combined call). SERP-evidence runs separately for both. Cross-market ranker runs at the end. |

`hasUnanchoredSignals` is:

```ts
input.referenceModel != null ||
  (input.modelClues?.length ?? 0) > 0 ||
  (input.variantClues?.length ?? 0) > 0;
```

### 5.2 What queries actually go out

The deterministic query compiler (`WebResearchKeywordService`) emits these shapes — every keyword goes through `normalize()` and deduped against `context.searchedKeywords` before firing:

| Builder                    | Used by                                        | Shape                                                                                  | Example (Samsung G85SD anchored sibling SKU)                                    |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `buildExactModelQuery`     | (fallback for cross-market with partial input) | `"<brand> <model>"` + suffix                                                           | `"LG 34GS95QE-B" monitor`                                                       |
| `buildModelWithSpecsQuery` | Combined strategy primary                      | `"<brand> <model>"` + first 1-2 spec values + suffix                                   | `"MSI 341CQPX" 240Hz 1440p monitor`                                             |
| `buildSiblingSkuQuery`     | Anchored + enriched-unanchored                 | `"<refBrand> <refModel>"` + modelClues + first 1-2 spec values + variantClues + suffix | `"Samsung Odyssey OLED G8 S34DG850SU" G85SD monitor` (verbatim from `1df.json`) |
| `buildCrossMarketQuery`    | Combined strategy second leg                   | `"<brand> <model>"` + `equivalent model name US EU UK` + suffix                        | `"LG 34GS95QE-B" equivalent model name US EU UK monitor`                        |

The **suffix** comes from `CategoryPromptConfig.searchKeywordSuffix` in the category JSON config (`libs/config/src/lib/categories/<slug>/config.json` — e.g. for monitors it appends "monitor"). It is the disambiguation tail. When category is unknown the suffix is empty.

### 5.3 The web search itself — `ProductWebSearchService.search()`

```
normalizeKeyword (lowercase + collapse whitespace)
    │
    ▼
cache lookup: WebSearchCacheRepository.findCacheHit
    ├─ trigram similarity ≥ 0.7 (dynamicConfig.webSearch.cache.similarityThreshold)
    └─ date tolerance ±7 days (cache.dateToleranceDays)
    │
    │  HIT → return cached results, source='cache'
    │
    ▼  MISS
selectProvider:
    ├─ request.provider override?
    ├─ defaultProvider force?
    ├─ isOp + useExaForOp → Exa
    ├─ relevance ≥ minRelevanceForExa (0.8) → Exa
    └─ else → DataForSEO (default)
    │
    ▼
searchWithDataForSEO:
    ├─ Append `before:YYYY-MM-DD` to keyword (temporal filter)
    ├─ getLiveGoogleOrganicData(keyword, locationCode=US, lang=en, depth=15)
    └─ Flatten organic items (title, url, description)
    │
  OR
    ▼
searchWithExa:
    ├─ endPublishedDate = searchBefore.toISOString()
    ├─ exa.search(query, neural type, autoprompt, numResults=10, contents.text up to 10000 chars)
    └─ Map to common shape (title, url, summary, text)
    │
    ▼
cacheRepository.storeCache (TTL=90 days from dynamicConfig)
    │
    ▼
return ProductWebSearchResponse { results, provider, source, cacheHit, metadata }
```

The orchestrator pulls `searchBefore` from `input.searchBefore` (the comment's `externalCreationTs`) so older comments get pre-comment-date SERPs.

### 5.4 What happens to the SERP results

Every SERP fetch produces a `WebSearchAttempt` row appended to `context.webSearchAttempts` (keyword, provider, source/cacheHit, serpResults). Then for each fetch:

**Branch A — legacy "product+variants" extraction** (`WebSearchExtractionService.extractProductAndVariants`):

- Single LLM call (deepseek-v4-flash, `costLabel: web_research_extraction`).
- Input: input brand/model/displayName/category, comment date, and up to 15 SERP records from both product and cross-market legs (or just one leg for anchored/enriched-unanchored).
- Output schema: `{ product: {brand, model, displayName, confidence}, variants: [{model, region, confidence}], specs: string[] }`.
- Anchor-aware system prompt for Path 1 — explicitly instructs "do NOT return the anchor itself".
- Confidence gates: `minProductConfidence=0.5`, `minVariantConfidence=0.6`.
- Discarded if model length > 50, model = brand, model = input.model.
- **Effect via `applyExtraction`**: pushes the extracted product model + regional variants into `context.modelVariants` (capped at `maxModelVariants=20`) with `searched: false`. Source-tagged as `'web_search'` or `'cross_market'`. The cross-market loop adds an inferred size prefix when the original input had one.
- This drives the **re-search**: the next loop iteration of `runWebResearchLoop` calls `runSearchAndMatch` again with new variants.

**Branch B — SERP-evidence pipeline** (`WebResearchSerpExtractionService.extract` + `WebResearchCatalogResearchService.resolve`):

- Per-record LLM call (deepseek-v4-flash, `costLabel: web_research_serp_extraction`).
- Input: input brand, comment-mentioned model fragments, anchor (if any), and the SERP records as `[index] title \n description \n url`.
- Output: `records: [{ index, modelNumbers: string[] }]`. Must include one entry per record.
- Each model number then gets fuzzy-searched in the catalog (under the input brand, scoped by `categoryIds`).
- Resolved catalog hits become **new candidates** with `source='web_research'`, `confidence=0.8` (fixed floor), added directly to `context.candidates` (deduped, reference-excluded). They flow into the next match attempt.
- Unresolved SKUs go into `context.webOnlyModels` for the trace.

**Branch C — cross-market direct-match ranker** (`WebSearchExtractionService.rankCrossMarketCandidates`) — runs after extraction in combined and enriched-unanchored modes, **skipped in anchored**:

- LLM call (deepseek-v4-flash, `costLabel: cross_market_ranking`).
- Input: input product, discovered variants from SERP, top-5 existing candidates (confidence ≥ 0.6) labelled A/B/C/...
- Output: matches labelled A/B/C with confidence + reason.
- `minMatchConfidence=0.7` gate.
- The top match (if any) is pushed to `modelVariants` with `source='cross_market'` for re-search. Does **not** overwrite `activeInput.model` (would contaminate scoring anchor).

### 5.5 The loop termination

Loop continues as long as `applyExtraction` keeps producing new variants (`status` flipping back to `ENRICHED`). It naturally terminates via:

1. **No new variants extracted** → status doesn't return to `ENRICHED` → break.
2. **Keyword dedup** — every keyword is normalized and tracked in `context.searchedKeywords`; same keyword can't fire twice.
3. **Variant cap** — `maxModelVariants=20` total across all sources.
4. **Match accepted** — early-exit.

In practice this loop iterates 1–2 times.

---

## 6. The matcher and quality gates

`ProductMatcherService.evaluateCandidates` ([product-matcher.service.ts](libs/product-resolution/src/lib/services/product-matcher.service.ts)):

```
1. Normalize input (strip brand, basic-normalize, parse tokens)
2. Strict mode only: pre-filter by SpecComparisonService net score >= 0
3. Dedupe candidates by id (orderBy confidence desc, uniqBy id)
4. Score every candidate via CandidateScoringService (→ ProductSimilarityService)
   components: stringSimilarity, tokenOverlap, alphaMatch, aliasMatch, specSimilarity
5. orderBy(score, desc); pick best, second
6. Quality gate (anchored vs normal):

  Anchored ladder (evaluateAnchored — referenceProductId present):
    a. score < acceptThreshold → fail 'low_confidence_anchored' (same threshold as regular mode; the gate name is preserved for diagnostic clarity in traces)
    b. (best.score - second.score) < ambiguityGapAnchored → fail 'ambiguous_match_anchored'
    c. Then run the normal ladder

  Normal ladder (evaluate):
    a. stringSimilarity === 1.0 (exact alias) → accept (unless strict + spec mismatch)
    b. score < threshold (acceptThreshold=65 loose, acceptThresholdStrict=80) → fail 'low_confidence'
    c. strict only: any primaryMismatch → fail 'primary_spec_mismatch'
    d. strict only: matcherSpecMismatches > maxMatcherSpecMismatches → fail 'matcher_spec_mismatch'
    e. ambiguity: gap < 5 (ambiguityGap), with tiebreakers:
         - if best wins stringSimilarity but loses specSimilarity ("specNameConflict"): gap<2 → ambiguous
         - else if neither wins stringSim nor specSim → ambiguous
    f. critical numeric token gate: hit ratio < 1.0 without spec confirmation → 'critical_numeric_mismatch'
    g. strict only: suffix alpha tokens must all match → 'suffix_alpha_mismatch'

7. Pass → load full ProductModel, optionally auto-create alias (gated by aliasAutoCreate.minScore=80)
```

Threshold/config values from [resolution.json](libs/config/src/lib/configs/resolution.json):

```json
{
  "acceptThreshold": 65,
  "acceptThresholdStrict": 80,
  "ambiguityGap": 5,
  "search": {
    "maxModelVariants": 20,
    "maxCandidates": 50,
    "decisionModel": "deepseek-v4-flash",
    "webSearch": {
      "extractionModel": "deepseek-v4-flash",
      "minProductConfidence": 0.5,
      "minVariantConfidence": 0.6
    },
    "crossMarket": {
      "topCandidates": 5,
      "minCandidateConfidence": 0.6,
      "minMatchConfidence": 0.7
    }
  }
}
```

(`ambiguityGapAnchored` lives in `MatchingConfigService` defaults rather than the JSON. Anchored mode reuses the same `acceptThreshold` as regular mode.)

`buildVariantInputs` in discovery generates the variant inputs the matcher tries (original input first, then each `modelVariant` with `searched=true`, deduped by model string).

---

## 7. The pre-filter (Phase 3)

`CandidatePreFilterService.filter` ([candidate-pre-filter.service.ts](libs/product-resolution/src/lib/services/candidate-pre-filter.service.ts)):

Two gates applied per candidate, in order:

1. **Category gate** — `candidate.category.name` (case-insensitive) must equal `effectiveCategoryName` (resolved from `reference.productCategory.name`, else `categories[0].name`, else `input.categoryHint`).
2. **Spec gate** — `SpecComparisonService.compareSpecs` against `effectiveMatchSpecs` (the per-dimension input∩reference primary specs). Candidate with `primaryMismatches === 0` survives. Candidates without specs at all pass (cannot contradict).

If all dropped: `status = CANDIDATES_EMPTY` (triggers another web-research iteration if enabled).

`effectiveMatchSpecs` ([utils/effective-match-specs.ts](libs/product-resolution/src/lib/utils/effective-match-specs.ts)): for an anchored search, this is `referenceSpecs ∩ primarySpecs` overlaid with `inputSpecs ∩ primarySpecs` — **input wins per-dimension**. For unanchored search the pre-filter falls back to `inputSpecs ∩ candidate.category.primarySpecs`.

---

## 8. The decision LLM (Phase 4)

Only runs when **both** are true:

- `context.options.threadContext` is set (subtree processor always passes it with `commentBody`).
- `qualifyingCandidates.length >= 1` (post-pre-filter).

And only runs at all when the earlier phases did **not** produce a clean `MATCH_ACCEPTED` without web research (see `loopSignal === 'finalize-accepted'`).

`ProductResolutionDecisionService.decide` ([product-resolution-decision.service.ts](libs/product-resolution/src/lib/services/product-resolution-decision.service.ts)):

- Model: `deepseek-v4-flash` (`search.decisionModel`).
- `costLabel: product_resolution_decision`.
- Schema:
  ```ts
  { decision: 'resolved'|'unresolved',
    selectedCandidateId: string|null,
    confidence: 0..1,
    evidenceSummary, uncertaintyReasons[],
    shouldCreateAliases: [{model, region?, candidateId}] }
  ```
- Prompt body: comment body slice (first 500 chars), thread context (subreddit + title + opSummary + other resolved products), web-search evidence (up to 20 records with title/description/url/modelNumbers/→catalog), matcher diagnostics (normalized input, best candidate alias + score, runner-up score, failed gates) as **soft signal**, and the qualifying candidates with `id`, name, top-4 specs, and matcher confidence label (`low`/`moderate`/`high`).
- `acceptThreshold` = `search.acceptThreshold` (0.5 default) — sub-threshold resolved decisions get downgraded to `unresolved` with `below_accept_threshold` reason.
- Family-only heuristic: if every `searchEvidence` record's `resolvedProducts` is empty, the unresolved reason is `family_only_evidence`.

On `resolved`, the orchestrator sets `context.matchOutcome.resolvedProductModel`, `status = MATCH_ACCEPTED`, and `context.contextualResolution` for trace.

---

## 9. End-to-end example: `1df.json` Samsung G85SD case

This is the populated `searchContext` block at line ~9670 of `1df.json` — the case is `Samsung Odyssey OLED G8 S34DG850SU` (anchor) where the comment named `G85SD model`. Walk-through of what happened:

1. **Input** (originalInput at line 9703–9717):
   - `brand=Samsung`, `model=G85SD`, `displayName=Samsung Odyssey OLED G8 S34DG850SU G85SD`
   - `modelClues=["G85SD"]`, `categoryHint=Monitors`
   - `referenceModel=Odyssey OLED G8 S34DG850SU`, `referenceProductId=36d4064e-…`
   - `searchBefore=2025-11-11T10:53:43Z`

2. **Path 1 — Anchored variant**: subtree-processor called orchestrator with `referenceProductId` set.

3. **runAnchoredDiscoveryPhase**:
   - Loaded anchor entity (Samsung Odyssey OLED G8 S34DG850SU, Monitors).
   - `effectiveMatchSpecs = { curvature: 1800, panelType: 'oled', resolution: '3440x1440', screenSize: 34, refreshRate: 175 }` (from anchor primary specs; input had no spec overrides).
   - `modelVariants = [{model: 'Odyssey OLED G8 S34DG850SU', source: 'original'}, {model: 'G85SD', source: 'identification_clue'}]`.
   - Status = ENRICHED.

4. **runSearchAndMatch** (first pass):
   - Fuzzy search per variant → 4 hits (fuzzyHits=4, afterDedupe=4).
   - Reference excluded (the anchor) → 3 candidates left.
   - **Matcher**: best candidate "odyssey s34bg850su" (id `5b6a16a5…`) with score 71 (alphaMatch=0.33, tokenOverlap=0.56, stringSimilarity=0.87, specSimilarity=0). Anchored quality gate failed `low_confidence_anchored` (71 < `acceptThreshold`).
   - Status = `MATCH_REJECTED`.

5. **runWebResearchLoop iter 1**:
   - Status is `MATCH_REJECTED`, `webSearchEnabled=true` (always on for Path 1).
   - **Anchored strategy** → `buildSiblingSkuQuery`: `"Samsung Odyssey OLED G8 S34DG850SU" G85SD monitor` (see `searchedKeywords` line 10118–10120).
   - SERP fetch cache HIT, 16 results from `dataforseo`.
   - Legacy `extractProductAndVariants` ran with anchored system prompt — likely produced nothing (anchor product itself is what dominates the SERPs).
   - SERP-evidence pipeline ran: per-record extracted `modelNumbers` like `S34DG850SU`, `LS34DG850SUXEN`, `C34G55TWWP`, `LC34G55TWWPXXU`. Catalog re-search resolved two new candidates (the Samsung Odyssey G5 C34G55TWWP at `80fbbd86…`, and the anchor itself — filtered out). `webOnlyModels = ['LS34DG850SUXEN', 'LC34G55TWWPXXU']`.
   - One new web-research candidate was added (the G5 with matchScore 80, source `'web_research'`).
   - No new modelVariants from legacy extraction; loop exits.

6. **runFinalDecisionPhase**:
   - 2 qualifying candidates (G5 C34G55TWWP, S34BG850SU — both pass category=Monitors; spec gate likely failed for both but pre-filter saw they had specs in the right keys).
   - Decision LLM (deepseek-v4-flash) ran (`phaseTimings.decision = 7237ms`).
   - Returned `unresolved` with the evidence summary:
     > "The comment explicitly mentions 'G85SD model', which web search evidence confirms is the Samsung Odyssey OLED G8 S34DG850SU (G85SD series). However, the qualifying candidates list includes Samsung Odyssey S34BG850SU and Samsung Odyssey G5 C34G55TWWP, neither of which matches the G85SD model."
   - `contextualResolution.resolved = false, confidence = 0`.

7. **Finalize**: status = `UNRESOLVED`. (The comment named the anchor itself, which by design cannot be returned by the anchored search.)

---

## 10. Persisted artifact — what shows up in `searchContext`

The result builder writes both shapes of the context into `ref.searchContext`. Both `736.json` and `1df.json` show the same shape. Key blocks:

**Always present:**

- `input`, `originalInput`, `activeInput` — three copies of the input (immutable + legacy mutable variants).
- `options` — what the caller asked for.
- `status` — final terminal status (`RESOLVED` or `UNRESOLVED`).
- `decision.result` — the synthesized `FinalDecision` (matcher-only resolves get a synthetic one; decision-LLM resolves get the real one).
- `totals` (durationMs, cost, llmCalls, webSearchCalls).
- `iteration`, `iterationLog`, `phaseErrors`, `errors`.

**When discovery ran:**

- `candidates` (legacy, full `EvaluatedProduct` rows), `candidateDiscovery` (slim phase-aligned shape).
- `candidateFunnel` / `candidateDiscovery.funnel` — `fuzzyHits`, `embeddingHits`, `aliasHits`, `modelTokenHits`, `afterDedupe`, `afterReferenceExclusion`.
- `modelVariants` — the variant list with `searched` flags.
- `matchOutcome` — best matchResult + diagnostics + rejection reason.
- `effectiveMatchSpecs` — when anchored or when reference resolved.
- `preResolvedCategories` — when set on options.

**When web research ran:**

- `webSearchAttempts` — one row per SERP fetch with keyword, provider, source, cacheHit, serpResults (the raw 15 entries), discoveredSpecs, discoveredVariants, refinedInput.
- `searchEvidence` — per-record evidence with title/description/url/modelNumbers/resolvedProducts (the §7 shape).
- `searchedKeywords` — normalized keyword list (dedup ledger).
- `webOnlyModels` — extracted SKUs that didn't resolve.
- `crossMarketRanking` (in combined/enriched-unanchored mode).

**When decision LLM ran:**

- `contextualResolution` — the LLM's decision text + confidence (legacy field).
- `decision.result` populated from the LLM output.

---

## 11. Quick service-call map (one-page summary)

```
Caller: SubtreeProcessor.resolveProductReferences
  └─ ProductSearchOrchestrator.search
      ├─ [if referenceProductId] runAnchoredDiscoveryPhase
      │      └─ runSearchAndMatch
      │           ├─ CandidateSearchAgent.execute
      │           │     ├─ ProductFuzzySearchService.search    (Postgres trigram, per variant)
      │           │     └─ ProductEmbeddingMatchService.findMatches  (pgvector, only if 0 fuzzy hits)
      │           ├─ CandidatePreFilterService.filter           (category + spec gate)
      │           └─ ProductCandidateDiscoveryService.matchCandidates
      │                 └─ ProductMatcherService.evaluateCandidates
      │                       ├─ InputNormalizationService.normalizeForMatching/parseModelCode
      │                       ├─ CandidateScoringService.scoreAllCandidates  → ProductSimilarityService
      │                       └─ ProductMatcherQualityGateService.evaluate / evaluateAnchored
      │
      ├─ [else] ProductCandidateDiscoveryService.discover
      │      ├─ enrich
      │      │     ├─ BrandResolutionService.resolve
      │      │     └─ CategoryNameMatcherService.matchFromEnabledCategories  (per categoryHint)
      │      ├─ CandidateSearchAgent.execute
      │      └─ match (same chain as above)
      │
      ├─ runWebResearchLoop:
      │      WebResearchAgent.execute
      │       ├─ [anchored] runAnchoredResearchStrategy
      │       ├─ [enriched-unanchored] runEnrichedUnanchoredStrategy
      │       └─ [combined] runCombinedResearchStrategy
      │            for each strategy:
      │            ├─ WebResearchKeywordService.buildSiblingSkuQuery / buildModelWithSpecsQuery / buildCrossMarketQuery
      │            ├─ ProductWebSearchService.search        (cache → Exa or DataForSEO → cache write)
      │            ├─ WebSearchExtractionService.extractProductAndVariants  [LLM #1 — drives modelVariants]
      │            ├─ runSerpEvidence:
      │            │      ├─ WebResearchSerpExtractionService.extract       [LLM #2 — per-record SKUs]
      │            │      └─ WebResearchCatalogResearchService.resolve      (fuzzy each SKU → new candidates)
      │            └─ [non-anchored] runDirectMatchStrategy
      │                   └─ WebSearchExtractionService.rankCrossMarketCandidates  [LLM #3 — cross-market ranker]
      │       then re-enter runSearchAndMatch with new modelVariants/candidates
      │
      ├─ [if not finalize-accepted] runFinalDecisionPhase
      │      └─ ProductResolutionDecisionService.decide      [LLM #4 — disambiguator]
      │
      └─ finalize
             └─ [if aliasAutoCreate enabled] ProductAliasAutoCreateService.createAliasesFromAlternatives
             └─ status = RESOLVED | UNRESOLVED
                 ProductSearchResultBuilder.build → ProductSearchResult
```

LLM calls in a single web-research-bearing run (worst case, combined strategy): up to **4 LLMs** (extraction + SERP extraction + cross-market ranker + decision), plus up to 2 SERP API calls (product + cross-market). Anchored mode: up to **3 LLMs** (no cross-market ranker), 1 SERP fetch. With everything cached, only the 3–4 LLMs cost money.

---

## 12. Known smells visible from this map

These are observations, not prescriptions:

- **Two parallel extraction LLMs** (legacy product extraction + per-record SERP SKU extraction) over the same SERP results, both writing to different parts of the context. The legacy path drives `modelVariants`; the SERP-evidence path drives `candidates` directly. The legacy path was kept "alongside" the new one rather than replaced.
- **Three confidence systems coexist**: matcher score (0–100), web-research extraction confidence (0–1), decision LLM confidence (0–1). They get rendered into the decision prompt in three different formats (matcher: low/moderate/high label; cross-market: numeric; decision: numeric).
- **Web-research candidates get a fixed `confidence=0.8`** regardless of evidence quality, then are re-scored by the matcher anyway.
- **`activeInput` vs `originalInput`** — the comment guards multiple times that `activeInput.model` must not be overwritten with SERP-extracted values ("contaminates the matcher's scoring anchor"). Suggests the dual-input design is fighting its own callers.
- **The web-research loop iterates** but in practice almost always once; the `searchedKeywords` dedup + variant cap make a second iteration rare. The loop scaffolding could collapse to a single pass.
- **`runSearchAndMatch` is called from two places** with subtly different pre-state (anchored: enrichment already done; loop: enrichment done in previous iteration). The interface is the same but the contract differs.
- **`ProductSearchContext` carries both the §7 shape and the legacy fields simultaneously** (every `@deprecated WI 9` comment is still alive). The result builder cannot drop the legacy fields because the agents still write to them.
- **Three near-identical strategy branches in `WebResearchAgent`** (anchored / enriched-unanchored / combined). Each issues one SERP, runs legacy extraction, runs SERP-evidence, applies extraction. Combined adds a second SERP. Differences are: which keyword builder, whether the anchor-aware system prompt is used, whether cross-market ranker runs. They could likely fold into one pipeline parameterized by strategy.
- **Fuzzy → embedding fallback** is wired so embedding only fires when fuzzy returns zero. In practice this means embedding almost never runs (fuzzy at threshold 0.4 catches most things) — its cost/benefit ratio is unclear from the current data.
- **Path 0 + registry instant-resolve live in the subtree processor, not the orchestrator.** The orchestrator only handles Path 1 (anchored variant) internally. Same-as resolution is invisible to the persisted `searchContext`.
- **`SpecComparisonService` is called from three places** with subtly different inputs (matcher pre-filter, pre-filter service, matcher scoring). Each one has its own primarySpecs/matcherSpecs derivation.
- **The matcher tries multiple variant inputs** (`buildVariantInputs`) sequentially; first acceptance wins. The web-research loop also generates variants; both mechanisms accumulate state on `context.modelVariants` with slightly different semantics (`searched` flag).
- **`aliasAutoCreate` is disabled in current resolution.json** (`enabled: false`) but `ProductMatcherService.maybeAutoCreateAlias` is invoked unconditionally inside the matcher (guarded internally). And the orchestrator also calls `aliasAutoCreate.createAliasesFromAlternatives` for web-discovered variants on finalize — two distinct alias-creation paths.

---

## 13. Findings — is this overengineered?

**Yes, but the right move is a targeted simplification, not a full rewrite.**

### 13.1 Where the complexity is justified

- **Fuzzy + embedding + web-research candidate sources** — three independent recall mechanisms for a hard problem (Reddit users name products inconsistently). Each catches things the others miss.
- **Pre-filter before decision LLM** — saves money and prevents the LLM from seeing obvious wrong-category junk.
- **Quality gates with anchored variants** — anchored mode genuinely needs different thresholds (sibling SKU discrimination is harder than first-time identification).
- **Cache-first SERP** — non-negotiable at this volume.

### 13.2 Where it's overengineered (priority-ordered)

1. **The dual-shape `ProductSearchContext`.** Every `@deprecated WI 9: removed when…` comment is a flag that a refactor was started and abandoned. The legacy fields are still load-bearing because agents still write to them. This is the single biggest source of confusion when reading the code.
2. **Two LLMs extracting from the same SERPs.** The legacy `product.model` half of `WebSearchExtractionService.extractProductAndVariants` is redundant with the SERP-evidence pipeline. Only cross-market variants are uniquely produced by the legacy path.
3. **Three near-identical web-research strategy branches** (~300 lines of mostly-duplicate code in `WebResearchAgent`). They differ in three small ways: which keyword builder, anchor-aware prompt y/n, cross-market ranker y/n. Could be one pipeline + a strategy descriptor.
4. **`activeInput` vs `originalInput` vs `input`.** Three copies of the input because one of them might get mutated by web research, and the matcher needs to fall back to the original. The defensive comments scattered through the code ("don't overwrite this, it contaminates the matcher") signal a design that's fighting itself.
5. **The web-research loop.** It's a `while(true)` that almost always iterates once. Loop scaffolding + `searchedKeywords` dedup ledger + `maxModelVariants` cap could all collapse into a single-pass function.
6. **Three confidence systems** (matcher 0-100, extraction 0-1, decision 0-1) rendered three different ways in the decision prompt.
7. **Two alias-creation paths** (matcher inline + orchestrator finalize).
8. **Routing logic split between subtree-processor and orchestrator.** Path 0 + registry instant-resolve live in the caller; Path 1 anchored mode lives in the orchestrator. Same conceptual question ("is this a known product?") answered in two places with different code.

### 13.3 Why not a full rewrite

A full rewrite throws away thousands of edge cases the current code has learned — suffix-alpha gates, critical numeric token rules, brand-strip variants, year adjustments, anchor self-match exclusions, etc. Those came from real failures and would need to be re-discovered.

The architecture is fine: fuzzy/embedding/web recall → pre-filter → matcher → decision LLM. The shape is right. It's the _structural debt_ that hurts.

### 13.4 Recommended simplification plan

Five to six focused PRs, each independently shippable:

1. **Finish WI 9 — drop the legacy `ProductSearchContext` fields.** Single shape. Biggest readability win for the least behavioral risk.
2. **Delete the legacy product extraction.** Keep cross-market as a smaller separate concern (or fold into the decision LLM as a "spot regional renames" capability). **Verify cross-market's hit rate via Loki first** — if it rarely produces unique resolutions, remove the whole legacy path in one go.
3. **Collapse the three web-research strategy branches** into one parameterized pipeline.
4. **Inline the orchestrator loop** to a single pass — keep the re-search-after-web-research semantics but drop the `while(true)` shape.
5. **Move Path 0 + registry instant-resolve into the orchestrator.** One place answers "do I know this product already?".
6. **Pick one confidence scale.**

Each is a clean, scoped change. Expected outcome: same architecture, ~40% less code, one shape per concept.
