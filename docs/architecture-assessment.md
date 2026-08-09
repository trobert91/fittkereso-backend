# Architecture Assessment: Over-engineered, or necessary complexity?

**Scope:** `ebike-backend` — Nx monorepo, 5 apps, 37 libs, ~43k LOC of non-test TypeScript (883 files), 60 test files.

**Short answer:** The product is genuinely hard, and the _core_ of the system is complexity that the problem demands — not gold-plating. But around that core sits a meaningful layer of **ceremony**: speculative abstractions with one implementation, an LLM-provider layer that's ~60% dormant, thin wrapper libs that inflate the module count, and two oversized "god" services. Call it **~70% essential, ~30% accidental**. It is over-_modularized_ in places, not over-_engineered_ in the sense of solving problems you don't have.

The distinction matters: this isn't a CRUD app dressed up in enterprise patterns. It's an LLM extraction pipeline — those are legitimately multi-phase and stateful. The waste is concentrated and removable without touching the hard parts.

---

## What is genuinely necessary (the 70%)

These are load-bearing and appropriately sized for the problem. Don't touch them.

| Area                                                             | Why it's justified                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`thread-processor`** (the 8-phase pipeline)                    | LLM extraction _is_ multi-pass: identify → extract → resolve → validate → autofix. Each phase uses a different model, schema, and prompt. You cannot collapse this into one call and get correct output.                   |
| **`resolution`** (4.7k LOC)                                      | Matching a free-text product mention ("the Sony XM5s") to a catalog entry via fuzzy + embedding + web + LLM scoring with quality gates is a hard problem with real false-positive cost. The _orchestration_ here is clean. |
| **`product`** core matching                                      | `ProductSimilarityService`, `SpecComparisonService`, rating/merge logic — this is real domain logic, correctly concentrated.                                                                                               |
| **`relevance`** (3.4k LOC)                                       | Scoring comment/thread relevance is a genuine scoring problem; the core calculator is appropriately sized.                                                                                                                 |
| **`config` + `dynamic-config` split**                            | Environment/secrets vs. runtime tuning knobs is a correct separation. The 1,222-line `dynamic-config-data.interface.ts` is load-bearing config surface, not scaffolding.                                                   |
| **`database`** (90 files)                                        | TypeORM entities + repositories for ~15 entity groups. Proportionate.                                                                                                                                                      |
| **3 production apps** (api, review-collector, product-collector) | Each is a distinct deployable with a distinct job. Correct.                                                                                                                                                                |

The pipeline being "8 phases" is **not** the over-engineering. That's the shape of the problem.

---

## What is accidental complexity (the 30%)

Ranked by how cheaply you can remove it vs. the clutter it removes.

### 1. The LLM provider layer is ~60% dormant scaffolding — **highest ROI to fix**

Seven libs implement provider abstraction: `ai-core` (interfaces/registry), `ai` (orchestration), and five providers — `openai`, `deepseek`, `claude`, `gemini`, `openrouter`. The registry/interface design itself is _good_.

The problem is usage. Every model the pipeline actually selects (verified in `libs/config/src/lib/configs/processor.json`, `resolution.json`, `keywordResearch.json`) is one of exactly two:

- `deepseek-v4-flash` — everything: identification, extraction, labeling, validation, OP summarization, relevance, resolution decisions
- `gpt-5.4-mini` — image analysis only

**`claude`, `gemini`, and `openrouter` are registered at startup but never selected by any code path.** Their model strings appear only in their own `*.json` pricing configs (`claude.json`, `gemini.json`, `openrouter.json`) — never in a pipeline config. They are ~880 LOC + three SDK dependencies of "just in case." There is no runtime routing by cost/latency/availability; routing is just `processor.json` hardcoding a model name.

**Recommendation:** Either (a) delete `claude`/`gemini`/`openrouter` until you actually need a third provider — the registry makes re-adding one trivial — or (b) collapse all five providers into a single `libs/ai-providers` with per-provider subdirectories. Keep `ai-core` + `ai`. This removes 3 libs (or 4) and 3 unused SDKs with zero functional loss.

### 2. The "strategy pattern" with one strategy — **speculative abstraction**

The pipeline lives under `libs/thread-processor/src/lib/implementations/product-identity-first/`. The `implementations/` folder and a `ThreadExtractorRegistry` exist to swap between multiple extraction strategies — but **there is only one** (`product-identity-first`). No `category-first`, no sibling. The registry hardcodes a single-element array.

This is three directory levels and a registry indirection paying for flexibility that never materialized.

**Recommendation:** Low priority (it's cheap to keep), but if simplifying: flatten `implementations/product-identity-first/` up and drop the registry until a second strategy is real. The cost today is mostly navigational/cognitive, not runtime.

### 3. Two god services — **under-decomposition at the core**

- `subtree-processor.service.ts` — **2,572 lines, 25 injected dependencies.** ~75% is clean delegation, but the resolution phase (~`resolveComment`, several hundred lines inline) is a state machine that leaked into the orchestrator: registry-cache routing, web-search gating, lock-based concurrency, group-election logic.
- `product-registry.service.ts` — **1,098 lines** doing registry-building + cheat-sheet rendering + alias dedup.

**Recommendation:** Extract a `ProductResolutionOrchestratorService` out of the orchestrator's resolution block, and split cheat-sheet rendering out of `ProductRegistryService`. This is method-extraction + rewiring, not rearchitecting — the seams are already visible.

### 4. Thin wrapper libs inflate the module count — **fragmentation, not danger**

Several libs are wrappers thin enough that they're ceremony rather than modules:

| Lib        | Approx LOC of real logic | Note                                        |
| ---------- | ------------------------ | ------------------------------------------- |
| `scraper`  | ~11 (one method)         | Passes through to `zyte`. Pure indirection. |
| `supabase` | ~19                      | `createClient()` + cache.                   |
| `storage`  | ~47                      | Factory over `bunny`.                       |
| `zyte`     | ~81                      | Thin HTTP wrapper, 2 importers.             |
| `bunny`    | ~173                     | Low usage.                                  |

37 libs for a 5-app system is at the upper edge of navigable. Cross-lib **duplication** also shows up here — spec comparison logic exists in `product/similarity`, `product/duplicate/spec-comparison`, _and_ `resolution/matching/quality-gates`; normalization is reimplemented in three places; the fuzzy and embedding recall strategies duplicate their variant-gen + dedup pattern. None of this is dangerous, but it's the tax of splitting before the shared abstraction was clear.

**Recommendation:** Consolidate the storage/scraping wrappers (`scraper`+`zyte`+`exa` → web-scrapers; `storage`+`bunny`+`supabase` → storage). Unify spec comparison on `SpecComparisonService` as the single source of truth. Medium priority — do it opportunistically, not as a project.

### 5. `benchmark` (38 files) and `mcp` (25 files) are dev tooling

Not production-critical — they're prompt-tuning and live-inspection tooling. Legitimate to have, but worth recognizing they're ~63 files of build/dependency surface that isn't shipping to users. No action needed; just don't count them against "is the product over-built."

---

## Verdict

**Is it over-engineered?** Partially, and removably so.

- The **hard core** — multi-phase LLM extraction, product resolution, relevance scoring — is necessary complexity. A reviewer who calls _that_ over-engineered doesn't understand the problem. You are not building a CRUD site; you're building an extraction pipeline, and those are inherently stateful and multi-stage.
- The **accidental complexity** is concentrated in: (1) a half-dormant 7-lib provider layer, (2) a one-implementation strategy pattern, (3) two oversized services, (4) a sprawl of thin wrapper libs with some cross-lib duplication.

**If you do nothing else, do #1** (drop or collapse the unused providers) **and #3** (split the two god services). Those two give the largest reduction in "this feels heavy" per hour spent, and neither risks the pipeline. The rest is cleanup you can fold into normal work as you touch those files.

The honest framing for a stakeholder: _"The pipeline is as complex as the problem requires. We've accumulated some scaffolding around it — provider integrations we're not using yet and a couple of services that grew too large — that we can trim without risk. It's not bloated; it's under-pruned."_
