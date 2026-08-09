# Product Resolution Agent Redesign — Implementation Plan

This document is the step-by-step execution plan for the design in [product-search-agent-refactor.md](./product-search-agent-refactor.md). Read that doc first; this one assumes its decisions and translates them into ordered work that's safe to merge incrementally.

The plan is organized into ten numbered work items. Each item is intended to land as one PR, in order. Within each item: the goal, the files to touch, the concrete changes, the tests, and the verification step.

The user has stated that **all pre-existing `ProductSearchContext` data will be wiped**, so we don't need a backward-compatible shape during the rollout — but we do need each PR to leave the system in a working state, since the data wipe happens once at the end (work item 10).

## Work Item 1 — Drop `searchKeyword` end-to-end

**Goal.** Remove the free-text `searchKeyword` field from the identification LLM, the input model, and every consumer. Replace its disambiguation role with a deterministic per-category `searchKeywordSuffix` config field. This is the simplest item and a prerequisite for §4 (`ProductWebResearchService`'s deterministic keyword compiler).

**Files to change.**

- `libs/thread-processor/src/lib/implementations/product-identity-first/schemas/subtree-identification.schema.ts` — remove the `searchKeyword` Zod field and the JSON-schema entry.
- `libs/thread-processor/src/lib/implementations/product-identity-first/prompts/subtree-identification.prompt.ts` — remove the `searchKeyword` example output and the `searchKeywordStr` rendering of `config.promptConfig.searchKeywordInstruction`.
- `libs/database/src/lib/postgres/types/product-category-config.ts` — remove `searchKeywordInstruction`; add `searchKeywordSuffix?: string` to the per-category `promptConfig` (or, if the suffix is purely a search concern, to `matchConfig` — pick whichever lets it travel with `CategoryMatchConfig`).
- `libs/config/src/lib/categories/<slug>/config.json` (every category) — drop `searchKeywordInstruction`; add `searchKeywordSuffix` carrying the disambiguation tokens (`"monitor"` / `"ultrawide monitor"` / `"projector"` / `"IEM"` / `"headphones"` / etc.). Pull each category's existing instruction into the suffix.
- `libs/database/src/lib/models/product-resolution-context.ts` — drop `searchKeyword` from `ProductResolutionInput`.
- `libs/product-resolution/src/lib/search-agent/agents/web-research.agent.ts` (lines 604-630, `buildProductKeyword`) — remove the `if (context.activeInput.searchKeyword)` short-circuit; always compile from structured fields. Append the suffix from `CategoryMatchConfig` when present. (The full compiler rewrite happens in WI 6; this item just stops using `searchKeyword` from input.)
- `libs/product-resolution/src/lib/search-agent/services/contextual-resolution.service.ts` (lines 169-170) — drop the `Search keyword: ...` line from the prompt.
- `libs/thread-processor/src/lib/implementations/product-identity-first/services/subtree-processor.service.ts` — drop the field where it flows through.
- `apps/review-collector/src/modules/deferred-resolution/services/deferred-resolution.service.ts` — drop the field where it flows through.
- `libs/database/src/lib/models/product-reference-context.ts` — drop `searchKeyword`.
- `libs/debug/src/lib/models/processing-trace-data.ts` — drop trace serialization of the field.
- `libs/debug/src/lib/services/debug-trace-assembler.service.ts` — drop UI/debug rendering.
- `apps/benchmark/fixtures/identification/*.json`, `apps/benchmark/candidates/identification/*.md` — regenerate or hand-strip `searchKeyword` from fixtures so benchmark suites still parse.

**Tests.**

- New unit tests in `libs/thread-processor/.../subtree-identification.schema.spec.ts` (or extend existing) verifying the schema rejects responses that include `searchKeyword` (loose mode: ignored; strict mode: rejected).
- Update existing tests in `libs/product-resolution/.../web-research.agent.spec.ts` for `buildProductKeyword`: when no `searchKeyword` is on input, it builds from structured fields + suffix. Drop tests that asserted "use searchKeyword verbatim."
- Update `libs/product-resolution/.../contextual-resolution.service.spec.ts` (if present) to assert the prompt no longer renders `Search keyword:`.

**Verification.**

- `npx nx test thread-processor product-resolution debug`.
- `npx tsc --noEmit -p apps/api/tsconfig.app.json`, `apps/review-collector/tsconfig.app.json`, `apps/product-collector/tsconfig.app.json`, `apps/mcp/tsconfig.app.json`.
- Boot `npm run start:reviews:scheduler` in dev, replay one identification batch via the test harness (`apps/review-collector/src/modules/test/...`), confirm logs show no missing-`searchKeyword` warnings.

---

## Work Item 2 — Filter the reference product out at candidate discovery; remove `anchor_self_match`

**Goal.** Move the reference-exclusion role from `ProductMatcherQualityGateService.evaluateAnchored`'s post-scoring `anchor_self_match` gate into pre-scoring candidate filtering. The matcher stops needing to know `referenceProductId`. This isolates a focused change to the candidate-discovery path that's safe to land before any of the larger §1 collapse.

**Files to change.**

- `libs/product-resolution/src/lib/services/product-matcher.service.ts` — at the candidate-list building step (before `filterBySpecs`/`scoreAllCandidates`), drop any candidate whose `productId === input.referenceProductId`. Record the count in the candidate funnel as `afterReferenceExclusion`.
- `libs/product-resolution/src/lib/services/product-matcher-quality-gate.service.ts` — remove the `anchor_self_match` block (lines 177-184); remove `referenceProductId` from `evaluateAnchored`'s signature; remove the runner-up special case at line 199 (`second.candidateId !== referenceProductId`) — the runner-up can never be the reference now.
- `libs/product-resolution/src/lib/services/product-matcher.service.ts` (line 171-179 quality-gate call) — drop the `referenceProductId` parameter from the `evaluateAnchored` call.
- `libs/product-resolution/src/lib/search-agent/agents/web-research.agent.ts` — wherever web-search-discovered candidates are added back into the candidate pool, apply the same `referenceProductId` exclusion. Today the same gate caught these; now the filter has to.
- `libs/database/src/lib/models/product-search-context.ts` — extend the existing `CandidateFunnel` interface with `afterReferenceExclusion: number` (this is a non-breaking field add; the full context replacement comes in WI 8).

**Tests.**

- Update `libs/product-resolution/.../product-matcher-quality-gate.service.spec.ts`:
  - Drop tests for the `anchor_self_match` gate.
  - Adjust tests for the ambiguity-gap gate to remove the runner-up-is-anchor exemption.
  - Confirm `evaluateAnchored` no longer takes `referenceProductId`.
- New tests in `libs/product-resolution/.../product-matcher.service.spec.ts`:
  - With `referenceProductId` set, the candidate list given to scoring excludes the reference product.
  - Funnel reports `afterReferenceExclusion` correctly.
- New test for web-research add-back: candidates discovered via web search that match `referenceProductId` are filtered.

**Verification.**

- `npx nx test product-resolution`.
- Replay the trigger thread (`1dfc0e00-14ee-43db-9c22-c20d232d569c`) via the search-agent test controller (`apps/api/src/modules/test/search-agent-test/`); confirm no `anchor_self_match` rejections appear in the trace and the existing matcher diagnostics (`low_confidence_anchored`, `ambiguous_match_anchored`) still fire correctly.
- `npx tsc --noEmit` on every app.

---

## Work Item 3 — Capture the reference product as a slim object; compute `effectiveMatchSpecs`

**Goal.** When `input.referenceProductId` is set, `ProductSearchAgent` populates a slim `context.reference` object (productId, brand, model, productCategory, primary-spec subset) and computes `context.effectiveMatchSpecs = reference.specs ∩ primarySpecs, overlaid by input.specs`. No consumer changes yet — this work item just makes the values available; WI 4 wires them into the matcher.

**Files to change.**

- `libs/product-resolution/src/lib/search-agent/product-search-agent.service.ts` (lines 73-119 — the existing anchor block):
  - Replace `context.anchorEntity = anchorEntity` with the slim build:
    ```ts
    context.reference = {
      productId: anchorEntity.id,
      brand: anchorEntity.brand?.name ?? '',
      model: anchorEntity.model ?? '',
      productCategory: anchorEntity.productCategory
        ? { id: anchorEntity.productCategory.id, name: anchorEntity.productCategory.name }
        : undefined,
      specs: pickPrimarySpecs(anchorEntity.specs, matchConfig.primarySpecs),
    };
    ```
  - Compute `context.effectiveMatchSpecs` via a new helper (see below).
  - Keep the brand/category prefill logic that exists on lines 92-105 — but read from `context.reference` instead of holding the full entity.
  - Drop the `context.anchorEntity = anchorEntity` line. Any code that reads `context.anchorEntity` today must be migrated to read `context.reference` (grep first to find them all — likely `web-research.agent.ts` and the matcher path; both are touched anyway).
- `libs/database/src/lib/models/product-search-context.ts` — add `reference?` and `effectiveMatchSpecs` fields alongside (not replacing) existing fields; full replacement comes in WI 8.
- New helper `libs/product-resolution/src/lib/utils/effective-match-specs.ts` (or co-located with `product-matcher.service.ts`):
  ```ts
  export function computeEffectiveMatchSpecs(
    referenceSpecs: ProductSpecs | undefined,
    inputSpecs: StructuredSpec[] | undefined,
    primarySpecs: string[],
  ): ProductSpecs;
  ```
  - Restrict `referenceSpecs` to `primarySpecs` keys.
  - Convert `inputSpecs` (StructuredSpec[]) to a map and overlay per dimension.
  - Return the merged map.
- New helper `pickPrimarySpecs(specs, primarySpecs)` for the slim reference build (same library file).

**Tests.**

- `effective-match-specs.spec.ts`:
  - Reference set, no overrides → returns reference's primary specs.
  - Reference set, override on `screenSize` → screen size from override, rest from reference.
  - Reference unset → returns `inputSpecs ∩ primarySpecs`.
  - Override on a non-primary key → ignored (not in result).
  - Both unset → empty map.
- `product-search-agent.service.spec.ts`:
  - `referenceProductId` set → `context.reference` populated, `context.effectiveMatchSpecs` computed.
  - `referenceProductId` set but anchor entity not found → error logged, fall through to `InputEnrichmentAgent` (existing behavior preserved); `context.reference` stays undefined.
  - `referenceProductId` unset → both fields stay undefined/empty as appropriate.

**Verification.**

- `npx nx test product-resolution`.
- Replay the trigger thread; in the search-agent trace, confirm `context.reference.specs.screenSize === 34` and `context.effectiveMatchSpecs.screenSize === 34`.
- `npx tsc --noEmit` on every app.

---

## Work Item 4 — Pre-filter candidates against `effectiveMatchSpecs` and category

**Goal.** Implement §3 — drop candidates whose specs violate `effectiveMatchSpecs` or whose category disagrees with the reference, *before* they reach `ContextualResolutionAgent` (or its replacement). The trigger case is fixed at this point.

This work item still uses the existing agent-based `ProductSearchAgent` loop. The pre-filter sits between candidate discovery (matcher output) and the contextual-resolution step. The full §1 collapse happens in WI 7.

**Files to change.**

- New service `libs/product-resolution/src/lib/services/candidate-pre-filter.service.ts`:
  ```ts
  @Injectable()
  export class CandidatePreFilterService {
    constructor(
      private readonly specComparison: SpecComparisonService,
    ) {}

    filter(
      candidates: EvaluatedProduct[],
      effectiveMatchSpecs: ProductSpecs,
      effectiveCategoryName: string | undefined,
      matchConfig: CategoryMatchConfig,
    ): {
      qualifyingCandidates: EvaluatedProduct[];
      filteredCandidates: Array<{ candidateId: string; reason: 'match_specs' | 'category'; detail: string }>;
    };
  }
  ```
  - Spec rejection: any primary-spec mismatch using `SpecComparisonService` semantics (so `matcherSpecHierarchies` keeps working). One mismatched dimension is sufficient to drop the candidate. `detail` formats as `"<key> <candidate value> ≠ <expected value>"`.
  - Category rejection: candidate's `productCategory.name` (case-insensitive) not equal to the effective category name.
  - When `effectiveMatchSpecs` is empty and no effective category is set → no filtering, returns all candidates qualifying.
- `libs/product-resolution/src/lib/search-agent/product-search-agent.service.ts` — invoke the pre-filter after `CandidateMatcherAgent` produces candidates and before `ContextualResolutionAgent` runs. Store the result on `context.preFilter` (new field added in WI 8 fully; for now, add a transient field — or shove into `context.matchOutcome` until WI 8 replaces the context).
- `libs/product-resolution/src/lib/search-agent/agents/contextual-resolution.agent.ts` (and `services/contextual-resolution.service.ts`) — only see qualifying candidates. Drop the spec/category constraints that the prompt currently asks the LLM to enforce; the pre-filter has done that. Update the system prompt to say "every candidate listed already satisfies the required specs and category — your job is to disambiguate." (This shrinks the prompt and removes the soft enforcement that failed in the trigger case.)
- `libs/database/src/lib/models/product-search-context.ts` — add `preFilter?` field (full context replacement in WI 8).
- `libs/dynamic-config/src/lib/models/dynamic-config-data.interface.ts` — config gate to allow disabling the pre-filter for safe rollback (`searchAgent.preFilterEnabled: boolean`, default `true`; remove in WI 9).

**Tests.**

- `candidate-pre-filter.service.spec.ts`:
  - All candidates match `effectiveMatchSpecs` → all qualify; `filteredCandidates` empty.
  - One candidate violates `screenSize` → dropped with reason `match_specs`, detail `"screenSize 32 ≠ 34"`.
  - One candidate has disagreeing category → dropped with reason `category`, detail `"category 'tv' ≠ 'monitor'"`.
  - `matcherSpecHierarchies` compatible value (e.g. `OLED` for `WOLED`) → candidate qualifies.
  - Empty `effectiveMatchSpecs` and no category → all candidates qualify (no-op filter).
- Update `product-search-agent.service.spec.ts`:
  - Pre-filter empties candidate list → `ContextualResolutionAgent` not invoked, status set to UNRESOLVED.
  - Pre-filter keeps a subset → `ContextualResolutionAgent` sees only the subset.
- Update `contextual-resolution.service.spec.ts`:
  - System prompt no longer asks the LLM to enforce specs/category constraints.

**Verification.**

- `npx nx test product-resolution`.
- Replay the trigger thread; expected outcome: `S32DG800SU` (32" 16:9) is in `filteredCandidates` with reason `match_specs`, detail `"screenSize 32 ≠ 34"`. The `S34DG850SU` is filtered by candidate-discovery (WI 2) since it's the reference. Final status: `UNRESOLVED` (or whichever cheat-sheet candidate qualifies — verify against the actual catalog state). Trace shows zero LLM cost for the contextual-resolution step (because it was skipped on empty list) **or** the LLM only sees qualifying candidates.
- Replay 5–10 other previously-resolved threads and verify regression: they should still resolve to the same product. If any regress, capture the trace and check whether `effectiveMatchSpecs` was overly strict.
- `npx tsc --noEmit` on every app.

---

## Work Item 5 — `ResolutionInputEnricher` subject-switch classifier

**Goal.** When the comment switches subject ("I switched to the LG 27GR95" with a cheat-sheet `referenceProductId` set), clear `referenceProductId` so `ProductSearchAgent` doesn't inherit specs from a reference the comment isn't actually about.

**Files to change.**

- `libs/thread-processor/src/lib/implementations/product-identity-first/services/resolution-input-enricher.service.ts`:
  - New private method `detectSubjectSwitch(commentBody: string, referenceModel: string): 'rule' | 'llm-needed' | 'no-switch'`:
    - Regex pre-pass: `/i (just )?switched (to|from)/i`, `/instead( of)? (got|bought|use)/i`, `/i prefer the /i`, `/(but|now) i('m| am|'ve| have) (using|on|got) /i`. Only match when followed by another product-name token (capitalized word run + alnum). Returns `'rule'`.
    - When the comment is short and has no rule-match cues but `input.modelClues` includes a brand other than `referenceProduct.brand`, returns `'llm-needed'`.
    - Otherwise `'no-switch'`.
  - For `'llm-needed'` cases, call a small classifier prompt (gpt-5-nano via `AiChatService` with structured output `{ switched: boolean; reason: string }`). Cost-cap: at most one classifier call per resolution input.
  - When subject-switch is detected, log at debug level with `commentExternalId`, `referenceModel`, and the matching cue, and clear `referenceProductId`, `referenceModel`, `modelClues`, and `variantClues` from the output (they're all premised on the reference being the subject).
- New file `libs/thread-processor/.../prompts/subject-switch.prompt.ts` and `schemas/subject-switch.schema.ts` for the LLM fallback.
- `libs/dynamic-config/src/lib/models/dynamic-config-data.interface.ts` — add `enrichment.subjectSwitchClassifier: { enabled: boolean; useLlmFallback: boolean }` (default `enabled=true`, `useLlmFallback=true`).

**Tests.**

- `resolution-input-enricher.service.spec.ts`:
  - "I switched to the LG 27GR95" + cheat-sheet G8 → `referenceProductId` cleared.
  - "the 39 inch version" → not a switch, kept.
  - "I prefer the OLED panel" → not a switch (no follow-on product name), kept.
  - "but the LG 27GR95 is better" → switch detected, cleared.
  - LLM fallback path: rule misses, `modelClues` brand differs → classifier called, returns `switched=true` → cleared.
  - LLM fallback returns `switched=false` → kept.
  - `enabled=false` → all clearing skipped (rollback flag works).

**Verification.**

- `npx nx test thread-processor`.
- Use MCP `test_ai_chat` to validate the classifier prompt against 5 representative real comments (mix of switches and non-switches).
- `npx tsc --noEmit` on every app.

---

## Work Item 6 — `ProductWebResearchService.buildKeyword` — deterministic compiler

**Goal.** Extend today's `buildProductKeyword` (in `web-research.agent.ts:604-630`) to be the sole source of search queries — covering variant queries (combining `referenceModel` + `modelClues` + `variantClues`) and the per-category disambiguation suffix from §1.

**Files to change.**

- Move the existing `buildProductKeyword` and `buildCrossMarketKeyword` into a new dedicated service: `libs/product-resolution/src/lib/services/web-research-keyword.service.ts`. Pure functions, no DI dependencies except `CategoryConfigService` for the suffix lookup.
- New methods on the service:
  - `buildExactModelQuery(input, suffix)` — `"<brand> <model>" <suffix>` (or model-only when brand absent).
  - `buildModelWithSpecsQuery(input, effectiveMatchSpecs, suffix)` — model + first 2 spec values.
  - `buildSiblingSkuQuery(input, reference, suffix)` — quoted `referenceModel` + `modelClues` + `variantClues` + suffix. Triggered when `input.referenceProductId` is set and the comment named a variant.
  - `buildCrossMarketQuery(input, suffix)` — existing cross-market template.
- `libs/product-resolution/src/lib/search-agent/agents/web-research.agent.ts` — replace internal `buildProductKeyword` calls with the new service. Remove the legacy lines 604-639.
- `libs/config/src/lib/categories/<slug>/config.json` — already has `searchKeywordSuffix` from WI 1. No change needed here.

**Tests.**

- `web-research-keyword.service.spec.ts`:
  - `buildExactModelQuery({brand:'Samsung', model:'S34DG850SU'}, 'monitor')` → `'"Samsung S34DG850SU" monitor'`.
  - Brand missing → `'"S34DG850SU" monitor'`.
  - `buildModelWithSpecsQuery` adds first 2 spec values.
  - `buildSiblingSkuQuery` produces a query that includes `referenceModel`, the first `modelClue`, the first 1-2 `variantClues`, and the suffix.
  - `buildCrossMarketQuery` produces the cross-market form unchanged from today.
- Compatibility fixtures: 10 representative cases (including the trigger case Samsung G8, MSI MPG431CQPX vs MPG341CQPX, headphones IEM vs over-ear) where the old LLM-produced `searchKeyword` is checked into the test fixture and the compiler's output must be functionally equivalent (case-insensitive, same tokens, same suffix).

**Verification.**

- `npx nx test product-resolution`.
- Replay 5 threads with web-search-triggering comments; check the search-agent trace shows the new queries, cache-hit rate stays comparable, and SERP results are similar in count/quality to the previous LLM-keyword path.
- `npx tsc --noEmit` on every app.

---

## Work Item 7 — `ProductWebResearchService.SearchEvidence` + per-record extraction LLM

**Goal.** Rebuild the SERP-extraction step around `SearchEvidence[]`: one record per SERP result, each carrying `title`/`description`/`url`/`provider`/`queryIntent`, plus the LLM-extracted `modelNumbers: string[]` and the catalog `resolvedProducts: Array<{...}>` written back per-record after re-search. Specs on `resolvedProducts` are restricted to `primarySpecs`.

This is the largest piece of new code in the redesign. It is split from WI 6 (which only handles the keyword-compiler refactor) to keep diffs reviewable.

**Files to change.**

- New types (co-located in the service file or in `libs/product-resolution/src/lib/models/search-evidence.ts`):
  ```ts
  export interface SearchEvidence {
    title: string;
    description: string;
    url: string;
    provider: 'dataforseo' | 'exa';
    queryIntent: 'exact_model' | 'model_with_specs' | 'sibling_sku' | 'cross_market';
    modelNumbers: string[];
    resolvedProducts: Array<{
      brand: string;
      model: string;
      productId: string;
      specs: Record<string, string>; // primary specs only
    }>;
  }
  ```
- New service `libs/product-resolution/src/lib/services/web-research-extraction.service.ts` (or extend the existing `web-search-extraction.service.ts` heavily) — the per-record LLM extraction:
  - Prompt input: input brand, comment-mentioned model fragments, reference product (when set), and the `SearchEvidence[]` (without `modelNumbers` populated yet).
  - Prompt output: array of `{ index: number; modelNumbers: string[] }` written back into each `SearchEvidence.modelNumbers`.
  - Strict schema: only model numbers actually present in that record's `title`/`description`/`url`. Empty array when no real SKUs.
- New method on `ProductWebResearchService` (or rename of the current web-research module to fit):
  ```ts
  async runExtraction(searchEvidence: SearchEvidence[], context: ProductSearchContext): Promise<void>;
  ```
  Mutates `searchEvidence` in place — populates each record's `modelNumbers`.
- New method on the catalog re-search step:
  ```ts
  async resolveExtractedModels(searchEvidence: SearchEvidence[], inputBrand: string): Promise<{
    addedCandidates: SlimCandidate[];
    webOnlyModels: string[];
  }>;
  ```
  - Aggregates per-record `modelNumbers` into a deduped set.
  - For each unique SKU, calls the existing fuzzy-lookup path (whatever `CandidateSearchAgent` uses for model-token search — `ProductRepository.findByBrandAndModelFuzzy` or equivalent).
  - Writes catalog hits back into `resolvedProducts` on every `SearchEvidence` whose `modelNumbers` contained that SKU.
  - Restricts `resolvedProducts.specs` to the category's `primarySpecs`.
  - Aggregates SKUs that didn't resolve into `webOnlyModels`.
  - Returns `addedCandidates` (the resolved products as new `SlimCandidate`s the discovery list should pick up).
- `libs/product-resolution/src/lib/search-agent/agents/web-research.agent.ts` — wire the new flow:
  - After SERPs come back, build `SearchEvidence[]` with empty `modelNumbers`/`resolvedProducts`.
  - Call extraction service.
  - Call resolve service.
  - Add `addedCandidates` to the candidate pool (subject to the WI 2 reference-exclusion filter).
  - Store `searchEvidence` on the context (transient field; full replacement in WI 8).
- Drop the existing `discoveredVariants`, `discoveredSpecs`, and direct candidate-ranking outputs from `web-research.agent.ts` — they're replaced by `searchEvidence` and `addedCandidates`. Update any callers that read those fields.

**Tests.**

- `web-research-extraction.service.spec.ts`:
  - Single canonical model + marketing-name aliases on different records → each record gets the model numbers from its own text.
  - Multiple records with the same SKU → all carry it.
  - Record whose text has no real SKUs → empty `modelNumbers`, but record not dropped.
  - Predecessor-only matches → all records empty.
  - Prompt-injection style snippets containing fake model numbers → not returned.
  - Mock the LLM in unit tests; back with a small live-call fixture suite via `test_ai_chat`.
- New tests for the resolve step:
  - Each unique SKU is looked up under the input brand.
  - Catalog hits flow into `resolvedProducts` on every record carrying that SKU.
  - A record with two resolving SKUs gets two entries.
  - A SKU that doesn't resolve stays in `modelNumbers` and appears in `webOnlyModels`.
  - `resolvedProducts.specs` contains only `primarySpecs` keys (verified against a multi-spec catalog fixture).

**Verification.**

- `npx nx test product-resolution`.
- Replay the trigger thread. Confirm:
  - `searchEvidence` array populated.
  - Per-record `modelNumbers` includes `G80SD`, `LS32DG802SNXZA`, `S32DG80` for the relevant Samsung SERPs.
  - `resolvedProducts` on those records points to the catalog `S32DG800SU`.
  - WI 4's pre-filter then drops `S32DG800SU` for `screenSize` mismatch and the final outcome is `unresolved`.
- `npx tsc --noEmit` on every app.

---

## Work Item 8 — Replace `ProductSearchContext` with the §7 phase-aligned shape

**Goal.** Wipe the existing `ProductSearchContext` shape and replace it with the redesigned object from §7 — phase-aligned, slim candidates, no `originalInput`/`activeInput`/`iterationLog`/`anchorEntity`. The user has confirmed that pre-existing `ProductSearchContext` data will be removed; this work item performs that wipe.

**Files to change.**

- `libs/database/src/lib/models/product-search-context.ts` — full rewrite to match §7. Remove every field from the current shape. Add the new structure exactly as in §7 (top-level `input`/`options`/`reference`/`effectiveMatchSpecs`, plus `candidateDiscovery`/`webResearch`/`preFilter`/`decision`/`status`/`resolvedProduct`/`totals`/`errors`, and the `SlimCandidate` type).
- `libs/product-resolution/src/lib/search-agent/models/product-search-context.ts` — re-export the new types.
- `libs/product-resolution/src/lib/search-agent/product-search-agent.service.ts` — rewrite `buildInitialContext` and every site that mutates `context` to use the new shape:
  - Initial state: `{ input, options, status: 'UNRESOLVED', errors: [], totals: { durationMs: 0, cost: 0, llmCalls: 0, webSearchCalls: 0 } }`.
  - Reference resolution writes `context.reference` and `context.effectiveMatchSpecs`.
  - Candidate discovery writes `context.candidateDiscovery`.
  - Web research (when run) writes `context.webResearch`.
  - Pre-filter writes `context.preFilter`.
  - Decision writes `context.decision` and (on success) `context.status='RESOLVED'`, `context.resolvedProduct`.
  - Each phase increments `context.totals` at completion.
  - Errors append to `context.errors` with the phase.
- All consumers of the old shape — find with `grep -r 'context\.\(originalInput\|activeInput\|matchOutcome\|contextualResolution\|anchorEntity\|crossMarketRanking\|iterationLog\|phaseTimings\|searchedKeywords\|modelVariants\|brandCorrection\|webSearchAttempts\)' libs apps`. Each call site needs to be migrated to read from the new structure or removed entirely (most are read-only diagnostics).
  - Likely files: `web-research.agent.ts`, `candidate-matcher.agent.ts`, `result-assembly.agent.ts`, `contextual-resolution.service.ts`, all four test controllers (`apps/api/.../resolution-test`, `apps/api/.../search-agent-test`, `apps/review-collector/.../product-test`, `apps/product-collector/.../product-test`), and the debug services.
- `libs/debug/src/lib/services/debug-trace-assembler.service.ts` and the MCP debug tools (`apps/mcp/src/modules/tools/debug/...`) — rewrite serialization to render the new tree-shaped trace.
- Database `synchronize: true` will pick up entity-side changes automatically per CLAUDE.md, but `ProductSearchContext` is stored as JSONB on `ProductReference` (verify the column name; it's typically `resolutionContext` or similar). Existing rows have the old shape — wipe them. One-shot migration script in `apps/api/migrations/` to `UPDATE product_reference SET resolution_context = NULL` (or whatever the column is) for all rows. This is the data wipe the user authorized.
- The MCP `get_thread_search_execution_traces` and `get_comment_traces` tools will need to render the new shape; `libs/debug/src/lib/services/loki-trace-reader.service.ts` (which reads processing traces from Loki) won't be affected since traces are written separately.

**Tests.**

- Update `product-search-agent.service.spec.ts` for the new context shape end-to-end. Every assertion that walked the old shape needs migration — easier to delete and rewrite the test file rather than patch.
- New `slim-candidate.spec.ts` verifying the spec subset is `primarySpecs`-only across all categories.
- Update the four test controllers' tests to the new context shape.
- Update debug trace tests in `libs/debug/.../debug-trace-assembler.service.spec.ts`.

**Verification.**

- `npx nx test product-resolution debug`.
- `npx nx run-many -t test` — full suite, since the context type is widely imported.
- `npx tsc --noEmit` on every app.
- Boot the review-collector locally, process a small batch of comments, verify the new trace shape is well-formed in Loki and renders correctly via MCP `get_comment_traces`.
- Verify the database wipe ran by checking `SELECT count(*) FROM product_reference WHERE resolution_context IS NOT NULL` is 0 right after the deploy.

---

## Work Item 9 — Collapse the agent set into the four §1 services

**Goal.** Implement §1 — replace `InputEnrichmentAgent` / `CandidateSearchAgent` / `CandidateMatcherAgent` / `WebResearchAgent` / `ContextualResolutionAgent` / `ResultAssemblyAgent` with the four collaborators: `ProductSearchOrchestrator`, `ProductCandidateDiscoveryService`, `ProductWebResearchService`, `ProductResolutionDecisionService`.

By this point, WIs 1-8 have already moved most of the business logic out of the agents. This work item is mostly a structural rename + flow rewrite.

**Files to change.**

- New file `libs/product-resolution/src/lib/search-agent/product-search-orchestrator.service.ts`:
  - Replaces `ProductSearchAgent.execute`.
  - Fixed flow:
    1. Build initial context.
    2. If `input.referenceProductId` set → reference resolution (slim build + `effectiveMatchSpecs`).
    3. `ProductCandidateDiscoveryService.discover(context)` → writes `context.candidateDiscovery`.
    4. Decide whether to run web research: existing trigger logic (no candidates, low-confidence match, or anchored variant) → `ProductWebResearchService.research(context)` → writes `context.webResearch`. Add web-discovered candidates to discovery's candidate pool.
    5. `CandidatePreFilterService.filter(...)` → writes `context.preFilter`.
    6. If `preFilter.qualifyingCandidates.length === 0` → set `status='UNRESOLVED'`, decision skipped with reason `no_qualifying_candidates`. Done.
    7. `ProductResolutionDecisionService.decide(context)` → writes `context.decision`.
    8. Apply decision result; set `context.status` and `context.resolvedProduct`.
- New file `libs/product-resolution/src/lib/services/product-candidate-discovery.service.ts`:
  - Combines `InputEnrichmentAgent` (brand/category enrichment), `CandidateSearchAgent` (fuzzy/embedding/alias/model-token search), and `CandidateMatcherAgent` (matcher + quality gate).
  - Single public method `discover(context)`.
  - Internally still uses `ProductMatcherService` and `ProductMatcherQualityGateService`.
- New file `libs/product-resolution/src/lib/services/product-web-research.service.ts`:
  - Wraps the keyword compiler (WI 6), provider search, the SERP-extraction LLM (WI 7), and the catalog re-search.
  - Single public method `research(context)`.
- New file `libs/product-resolution/src/lib/services/product-resolution-decision.service.ts`:
  - Wraps the LLM adjudication step.
  - Single public method `decide(context)`.
  - Returns the `FinalDecision` schema from §5.
- Delete the old agents: `input-enrichment.agent.ts`, `candidate-search.agent.ts`, `candidate-matcher.agent.ts`, `web-research.agent.ts`, `contextual-resolution.agent.ts`, `result-assembly.agent.ts`. Their `agents/` directory becomes empty and is removed. The agent loop file `product-search-agent.service.ts` is deleted; callers import `ProductSearchOrchestrator` instead.
- `libs/product-resolution/src/lib/product-resolution.module.ts` — register the four new services; unregister the agents.
- `libs/product-resolution/src/lib/search-agent/index.ts` — re-export the new public API.
- All callers (look at WI 1's "Other touch sites" list) — switch from `ProductSearchAgent` to `ProductSearchOrchestrator`. Same constructor surface (the same DI graph), so this is a search-and-replace.
- Remove the `searchAgent.preFilterEnabled` config flag from WI 4 — by this point the pre-filter is permanent.

**Tests.**

- New `product-search-orchestrator.service.spec.ts` with mocked collaborators:
  - Direct catalog hit (discovery returns one strong candidate, pre-filter passes, decision picks it) → resolved.
  - Web-discovered variant (discovery returns weak candidates → web research adds the right SKU → pre-filter passes → decision picks it) → resolved.
  - No qualifying candidates after pre-filter → unresolved with `unresolvedReason='no_qualifying_candidates'`, decision LLM not called.
  - LLM returns `none` → unresolved with `unresolvedReason='llm_returned_none'`.
  - Anchor sibling SKU, web research returns the right model.
- Migrate any agent-specific tests that survive into the new service tests, drop the rest.

**Verification.**

- `npx nx test product-resolution`.
- `npx nx run-many -t test build` (per CLAUDE.md CI command).
- Replay 10 historical threads end-to-end and compare resolved products against pre-refactor outcomes. Expected: identical for normal cases, fixed for trigger-case-pattern cases.
- `npx tsc --noEmit` on every app.

---

## Work Item 10 — Conservative-acceptance and matcher-diagnostic-as-evidence wiring

**Goal.** Implement §6 — preserve `ProductMatcherQualityGateService` diagnostics (`low_confidence_anchored`, `ambiguous_match_anchored`, etc.) as evidence rendered into `ProductResolutionDecisionService`'s prompt, so the LLM can prefer high-confidence picks. This is a small wrap-up after the structural changes.

**Files to change.**

- `libs/product-resolution/src/lib/services/product-resolution-decision.service.ts` — extend the prompt rendering to include matcher diagnostics per candidate. Render as a soft "evidence" block: `"matcher confidence: 0.51 (low; below acceptance threshold for variant resolution)"` rather than as a constraint.
- `libs/product-resolution/src/lib/services/product-resolution-decision.service.ts` — implement `unresolvedReason` resolution:
  - `'no_qualifying_candidates'` when pre-filter empty (set by orchestrator, not the decision service).
  - `'llm_returned_none'` when the LLM picked `none`.
  - `'low_confidence'` when the pick is below the acceptance threshold.
  - `'family_only_evidence'` when web research surfaced family-level matches but no specific SKU resolved (heuristic: `webOnlyModels.length > 0` and all `searchEvidence[*].resolvedProducts` are empty).
- Acceptance threshold lives in `dynamicConfigService.search.acceptThreshold` (or co-located with the other matcher thresholds — pick consistently).
- Update prompt examples (system message) to demonstrate the new behavior on the trigger case: 34" reference, comment "newer version… G8sd", web research found `G80SD`/`S32DG80`, pre-filter empties the list → outcome is `unresolved`.

**Tests.**

- Extend `product-resolution-decision.service.spec.ts`:
  - LLM picks a candidate; matcher diagnostics for that candidate are present in the rendered prompt.
  - Pick below acceptance threshold → `decision='unresolved'`, `unresolvedReason='low_confidence'`.
  - Web research surfaced models, none resolved → `unresolvedReason='family_only_evidence'` when LLM also returns none.

**Verification.**

- `npx nx test product-resolution`.
- Replay the trigger thread end-to-end through the full new pipeline. Expected outcome:
  - `context.reference.specs.screenSize === 34`
  - `context.effectiveMatchSpecs.screenSize === 34`
  - `context.candidateDiscovery.candidates` includes `S32DG800SU` (came in via web research)
  - `context.preFilter.filteredCandidates` includes `S32DG800SU` with reason `match_specs`, detail `"screenSize 32 ≠ 34"`
  - `context.preFilter.qualifyingCandidateIds` is empty
  - `context.decision.skipped.reason === 'no_qualifying_candidates'`
  - `context.status === 'UNRESOLVED'`
  - Cost: ~$0 for this comment (no decision LLM was called).
- Replay 20 other previously-resolved comments. Diff outcomes against pre-refactor. Expected delta: tighter precision (some former resolutions become unresolved when they shouldn't have been confident); zero false-positive picks of the trigger-case kind.
- `npx tsc --noEmit` on every app.
- Final regression sweep: run the `apps/benchmark` identification suite end-to-end and compare scores.

---

## Cross-cutting

### Dependencies between work items

```
WI 1 (drop searchKeyword) ──────────────────┐
                                            ├─ WI 6 (keyword compiler) ─┐
WI 2 (reference exclusion) ─────────────────┤                            │
                                            │                            │
WI 3 (slim reference + effectiveMatchSpecs) ┼─ WI 4 (pre-filter) ────────┤
                                            │                            │
WI 5 (subject-switch) ──────────────────────┘                            │
                                                                         │
                                            WI 7 (SearchEvidence + extraction) ─┤
                                                                                │
                                            WI 8 (context replacement) ─────────┤
                                                                                │
                                            WI 9 (collapse agents) ─────────────┤
                                                                                │
                                            WI 10 (conservative acceptance) ────┘
```

WIs 1, 2, 3, 5 are independent and can land in parallel. WI 4 depends on 3. WI 6 depends on 1. WI 7 depends on 6. WI 8 depends on 3+4+7. WI 9 depends on 8. WI 10 depends on 9.

### Configuration safety

Each work item that introduces new behavior adds a config gate (`dynamic-config-data.interface.ts`) for safe rollback:

- WI 4: `searchAgent.preFilterEnabled` (default `true`, removed in WI 9).
- WI 5: `enrichment.subjectSwitchClassifier.{enabled, useLlmFallback}` (default both `true`, kept).
- WI 7: `searchAgent.webResearch.serpExtractionLlm.enabled` (default `true`, kept; allows reverting to today's regex/LLM-keyword behavior in emergency).
- WI 10: `searchAgent.acceptThreshold` (config knob).

### Database wipe (work item 8)

`ProductSearchContext` is persisted as JSONB on the `product_reference` table (verify column name during implementation). The wipe is a one-shot SQL: `UPDATE product_reference SET resolution_context = NULL`. Run it once after WI 8 deploys. No migration is needed because TypeORM `synchronize: true` handles entity changes per CLAUDE.md.

### Performance targets

- The pre-filter is O(candidates × primarySpecs) — well under 1ms for typical 10-candidate sets.
- The `effectiveMatchSpecs` overlay reuses the reference fetch already happening at line 74 — zero additional DB calls.
- The per-SERP extraction LLM runs once per resolution (not per record) with the full `SearchEvidence[]` in context. Expected cost: comparable to today's `ContextualResolutionAgent` since it uses similar context size with a tighter output schema.
- The subject-switch LLM fallback runs at most once per resolution and only when rule-based cues are inconclusive — expected to fire on <5% of resolutions.

### Trace verification across the rollout

After every work item:

1. Pick 5 representative threads (mix of resolved/unresolved, with and without web search, with and without anchor).
2. Replay them via the test controller (`apps/api/.../search-agent-test`).
3. Capture the `ProductSearchContext` (post-WI-8: the new shape; pre: the old) via MCP `get_comment_traces`.
4. Diff against the previous run. Expected deltas at each work item:
   - WI 2: `anchor_self_match` rejections disappear; `afterReferenceExclusion` populated.
   - WI 3: `context.reference` and `context.effectiveMatchSpecs` populated where applicable.
   - WI 4: `context.preFilter.filteredCandidates` populated when constraints are violated; `S32DG800SU` is filtered for the trigger thread.
   - WI 5: comments with subject-switch cues no longer have `referenceProductId` propagated.
   - WI 6: SERP keywords reproduce previous shapes.
   - WI 7: `searchEvidence` array present with per-record extraction.
   - WI 8: full new context shape, all old fields gone.
   - WI 9: trace structure mirrors the four collaborators (no agent loop).
   - WI 10: matcher diagnostics in decision prompt; `unresolvedReason` set on every UNRESOLVED outcome.

### Final acceptance gate

The redesign is complete when:

1. The trigger comment (`2995b610-8307-4366-9a7b-49c3c3b7e344`) resolves to `UNRESOLVED` (or to the cheat-sheet anchor with confidence preserved), not `S32DG800SU`.
2. `apps/benchmark`'s identification + resolution suites run with no regressions vs. the pre-refactor baseline (within tolerance for cases where the pre-refactor was confidently wrong, like the trigger case).
3. No category configs reference `searchKeywordInstruction`.
4. `git grep anchorEntity` and `git grep anchor_self_match` return zero hits in `libs/product-resolution`.
5. `git grep "context\.\(originalInput\|activeInput\|matchOutcome\|contextualResolution\)"` returns zero hits.
6. `npx nx run-many -t lint test build` passes.
7. `npx tsc --noEmit -p apps/<app>/tsconfig.app.json` passes for `api`, `review-collector`, `product-collector`, `mcp`.
