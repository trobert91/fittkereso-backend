# Plan — More Reliable Same-Product Indicator for Scrape Resolution

## Problem

Scraping resolution currently walks a single path — `strict` mode through `ProductMatcherService` / `ProductMatcherQualityGateService` — that bakes in two opposing assumptions we cannot both satisfy:

1. **Treat the model-number string as ground truth.** `suffix_alpha_mismatch` + `critical_numeric_mismatch` + `primary_spec_mismatch` gates reject any candidate whose alias differs from the input by a trailing letter group.
2. **Accept aliases that exact-match the input name.** The exact-alias fast path at the top of `evaluate()` (`best.components.stringSimilarity === 1.0`) short-circuits gates and returns the candidate, even when its `displayName`/`model` differ on specs.

Three concrete cases to reason about — they pull in opposite directions:

- **Case A — false split (today).** `LG 37G800A` (displayspecifications.com) vs `LG UltraGear 37G800A-B` (arukereso.hu) — same product, two sources. All shared identity-type specs agree (VA, 36.5", 3840×2160, 165 Hz, 1000R, HDR, FreeSync, 2×HDMI+DP, built-in speakers, height-adjustable). Under `strict`, `suffix_alpha_mismatch` fires on `-B` and resolution fails; a duplicate product row is created. **Name-based gate is wrong; specs would have caught it.**

- **Case B — false merge (today).** `PG32UCDMR` merged onto `PG32UCDMZ` via alias auto-create; future scrapes hit the exact-alias fast path and reinforce the merge. The sources' specs already disagree (heightWithStand 53 cm vs 57.9 cm, weightWithStand 8.7 vs 8.8, brightness matches 1000 nits). **Name-based exact-alias fast-path is wrong; specs would have caught it — IF we look at the right specs.**

- **Case C — the hard one (must handle).** Four genuinely distinct products with near-identical core specs:

  | Spec | PG32UCDMZ | PG32UCDMR | PG32UCDP | PG32UCDM |
  |---|---|---|---|---|
  | Panel / size / res / refresh / response / contrast / HDR / G-Sync / FreeSync / ports (HDMI, DP, USB-C) / stand adj | **All identical** | | | |
  | Brightness | 1000 | 1000 | **250** | 1000 |
  | Width (w/ stand) | 71.8 | 71.8 | **71.4** | 71.8 |
  | Height (w/ stand) | 57.9 | **53** | 57.9 | 57.9 |
  | Depth (w/ stand) | 27.4 | **27.6** | 27.4 | 27.4 |
  | Weight (w/ stand) | 8.8 | 8.7 | **7.3** | 8.8 |
  | Power | 42 | 42 | **44** | 42 |
  | Plain USB-A | **no** | yes | yes | yes |
  | Energy class | G | **F** | G | G |

  All four share every "rigid identity" spec anyone would naturally declare (panel, size, resolution, refresh rate, response time, curvature, HDR). The only distinguishers are stand geometry (noisy across sources), brightness (noisy — resellers misreport), USB-A presence (often omitted from reseller spec sheets), and the **model-code suffix in the name** (`...MZ` vs `...MR` vs `...DP` vs `...M`). **Specs alone cannot tell these apart; the name suffix is the only reliable signal.**

Root cause: today's matcher uses a single global priority ("name first, specs as tiebreaker"). Cases A and B need "specs first"; Case C needs "name first". No single ordering works — we need both signals to vote, with asymmetric weight.

## Proposal

A two-axis decision: combine a **spec-identity vote** and a **name-identity vote**. Neither can unilaterally accept a merge. Either can unilaterally reject.

```
                        Name says SAME            Name says DIFFERENT           Name insufficient
                   (exact tokens after norm)   (critical alpha/numeric differ)   (too short / missing)
Specs SAME            ACCEPT (A, B re-match)       REJECT (Case C variants)      ACCEPT if spec coverage strong;
(identity specs                                                                  else → existing gates
 exact, full cov)

Specs DIFFERENT       REJECT (bad-alias case)      REJECT                        REJECT
(any identity
 spec mismatch)

Specs insufficient    ACCEPT on name only          REJECT                        Fall through to today's gates
(low coverage)        (with spec soft-confirm,
                       like today)
```

Both votes must be non-negative to accept; either vote being strictly negative rejects. This gives us the behaviour we want on all three cases:

- **Case A** — `LG 37G800A` vs `LG UltraGear 37G800A-B`. Name vote: tokens "37g800a" present in both after normalization, "-b" is a trailing single-alpha variant appendage → `same` (not `different`). Spec vote: full identity specs match → `same`. Both agree → accept.
- **Case B** — `PG32UCDMR` (input) vs `PG32UCDMZ` (candidate). Name vote: last alpha suffix differs (`mr` vs `mz`, neither an "appendage") → `different`. Spec vote: identity specs match (both 31.5" 4K 240 Hz OLED flat). Disagreement → reject. Alias auto-create is separately blocked because spec vote is insufficient evidence to overrule a `different` name vote.
- **Case C** — scraping `PG32UCDP` with candidates `PG32UCDMZ`/`PG32UCDMR`/`PG32UCDM` already in DB. Name vote: suffix chars differ → `different`. Spec vote: identity specs match → `same`. Disagreement → reject. Product stays separate, correctly.

The key shift: **"specs say same" is not sufficient to overrule "name says different"**. Specs can only overrule name when the name signal is `same` or `insufficient`.

### The two votes

#### Spec-identity vote

Per-category `identitySpecs` list. Comparison rules, distinct from today's `compareValues`:

- Both sides must have the spec; missing → not counted.
- Numbers must be **exactly equal** after canonicalization (integers compared as-is, floats rounded to the spec's declared precision — e.g. `screenSize` to 0.1 in). **No 5 % tolerance.**
- Strings: case-insensitive, trimmed, normalized — but **no hierarchy collapse** (OLED !== QD-OLED for identity; they're distinct panels).
- Booleans / arrays: exact equality.

Output: `{ vote: 'same' | 'different' | 'insufficient'; comparedCount: number; mismatches: string[] }`.

- `same` → every listed identitySpec is present on both sides and compares exactly.
- `different` → at least one identitySpec is present on both sides and doesn't compare exactly.
- `insufficient` → fewer than `minIdentitySpecCoverage` specs (category-configured, e.g. 4 out of 5 for monitors) are present-on-both.

Key design decision: `identitySpecs` is a separate list from `primarySpecs`/`matcherSpecs` because the semantics differ (see "What's different from matcherSpecs", below). For monitors a reasonable list is `["screenSize", "resolution", "refreshRate", "panelType", "curvature"]`.

#### Name-identity vote

Operates on the normalized model code (what `parseTokens` already produces).

- Extract `criticalAlphaTokens` (prefix alpha blocks — e.g. "mpg"), `criticalNumericTokens` (screen-size digits, refresh-rate digits), and `suffixAlphaTokens` (trailing alpha like "cqp", "mz", "mr", "dp").
- Compare input vs candidate:
  - `different` — any critical alpha or critical numeric token mismatches; OR suffix alpha tokens differ and the difference is **not a known variant-appendage pattern** (see below).
  - `same` — critical tokens match and suffix tokens either (a) are identical, or (b) differ only by a variant-appendage rule.
  - `insufficient` — one side has no parseable model code (e.g. short "MSI G5" style mentions — n/a for scraping).

**Variant-appendage rules** (for "name says same despite suffix difference"):

1. **Trailing region / color code of ≤2 chars when longer side is ≥5 chars.** Covers `37G800A` ↔ `37G800A-B`, `34GS95QE` ↔ `34GS95QE-B`. Rationale: regional/color suffixes are the only legitimate reason a well-formed model code gains a short trailing token.
2. **Exact prefix match where the shorter side is ≥5 chars.** Covers `PG32UCDM` ↔ `PG32UCDMZ` — wait, this would cause Case C to falsely merge. So: **prefix-match rule applies only when specs also vote `same` AND the longer side has no variant-dense suffix families already present in the candidate pool**. Actually — simpler: **do not enable the prefix-match rule by default**. It's a cat-C landmine. Require an explicit source-provided alias to merge prefix variants.

Rule (1) is the only auto-variant rule. Everything else needs identical suffix tokens.

Output: `{ vote: 'same' | 'different' | 'insufficient'; reason: string }`.

### Gate integration

Replace the current gate flow in `ProductMatcherQualityGateService.evaluate()` with:

1. **Compute both votes** up front using `best.specMatchDetails` and the already-parsed model codes.
2. **Decision matrix** (scrape context — new `options.context === 'scrape'`):
   - spec `different` OR name `different` → reject with combined reason.
   - spec `same` AND name `same` → accept (overrides low-score etc.).
   - spec `same` AND name `insufficient` → accept (scraping always has a name, so rare).
   - spec `insufficient` AND name `same` → accept (coverage gap but name is clean).
   - spec `insufficient` AND name `insufficient` → fall through to existing gates (today's behaviour).
3. **Comment-extraction context** (unchanged from today) — specs are sparse and name is noisy, so keep the current gate flow. Add spec-identity vote only as an **additional reject** signal (if specs are rich and vote `different`, reject) but not as an accept signal.

### Alias auto-create guard

Today's `ProductAliasAutoCreateService` fires for any accepted match above a confidence threshold. This is why `PG32UCDMR` got stamped onto `PG32UCDMZ`.

New rule: only auto-create an alias when **both votes say `same`**. If spec vote is `insufficient` and only the name agrees, no alias. Aliases that come from source-structured fields (DisplaySpecs "Model alias" list, Árukereső part numbers) are still trusted as-is — they're authoritative from the source.

## What's different from `matcherSpecs`

`primarySpecs` + `matcherSpecs` feed a *score* (confirmed minus weighted contradictions, normalized). The gate rejects on `primaryMismatches > 0` or `matcherSpecMismatches > maxMatcherSpecMismatches`, so they behave as **rejection triggers**. `identitySpecs` is an **acceptance trigger** — "all of these agree exactly, therefore this pair is the same product".

Concrete differences:

1. **Comparator strictness.** `compareValues` returns `'match'` for 27" vs 28" (3.6 % < 5 % tolerance) and for OLED vs QD-OLED (hierarchy `compatible`). Identity needs neither tolerance nor hierarchy collapse — 27 === 27, OLED === OLED.
2. **Coverage semantics.** `matcherSpecs` missing on one side is neutral (skipped). `identitySpecs` missing lowers coverage toward `insufficient` — i.e. missing data doesn't silently become a match.
3. **Role in the flow.** `matcherSpecs` fires *rejections* ("at most N mismatches"). `identitySpecs` produces a *vote* (`same`/`different`/`insufficient`) consumed by the new two-axis decision.
4. **Typical content overlap.** For monitors today `matcherSpecs = ["brightness", "weightWithStand", "powerConsumption"]` — all three are **noisy across sources** (Case A has brightness 320 vs 400 from the same SKU). They are anti-identity specs. Reusing `matcherSpecs` for identity would make Case A fail. We want a strict subset of `primarySpecs`, compared more strictly than `primarySpecs` does today.

**Could we avoid a third list?** Alternative: add `identityStrict: boolean` to each `primarySpec` and derive `identitySpecs` from the flag. Less config duplication, but conflates scoring with identity decisions. Either shape works; keeping them separate makes the intent explicit and keeps the new comparator isolated.

## Implementation steps

### Step 1 — Category config

1. Add `identitySpecs: string[]` and `minIdentitySpecCoverage: number` to `CategoryMatchingConfig` in [libs/database/src/lib/postgres/types/product-category-config.ts](libs/database/src/lib/postgres/types/product-category-config.ts).
2. Populate for monitors: `identitySpecs = ["screenSize", "resolution", "refreshRate", "panelType", "curvature"]`, `minIdentitySpecCoverage = 4`. Other categories: empty lists initially — they fall back to today's behaviour. Roll out per category.
3. Thread through `InputNormalizationService.getCategoryConfig` → `CategoryMatchConfig`.

### Step 2 — Spec-identity comparator

1. Add `computeSpecIdentityVote(specsA, specsB, identitySpecs, minCoverage, precisionMap?): { vote; comparedCount; mismatches }` to `SpecComparisonService`.
2. Rules as described. Add an optional `precisionMap?: Record<string, number>` for float specs where rounding matters (e.g. `{ screenSize: 0.1 }`).
3. Do not call `compareValues` — identity matching is stricter than `'match'` semantics.

### Step 3 — Name-identity vote

1. Add `computeNameIdentityVote(inputParsed: ParsedModelCode, candidateParsed: ParsedModelCode, config: NameIdentityConfig): { vote; reason }` to a new small service (or as a static helper alongside `token-parser.ts`).
2. Variant-appendage rule: trailing ≤2-char alpha token with a longer ≥5-char stem. Configurable via category if needed; start with the global rule.
3. Critical token agreement (alpha and numeric) is required for `same`.

### Step 4 — Gate wiring

1. Add `context: 'scrape' | 'extraction'` to `ProductResolutionOptions`. Default `extraction` for backward compatibility; `ProductScrapeUpdaterService.findExistingProductModel` passes `scrape`.
2. In `ProductMatcherQualityGateService.evaluate()`, compute the two votes at the top.
3. Apply the decision matrix for scrape context. For extraction context, leave today's gates; optionally add a *reject-only* use of spec-identity when identity coverage is strong (guards against LLM hallucinating a spec that contradicts all sources).
4. Remove the hard exact-alias fast-path (`stringSimilarity === 1.0`) in scrape context — always run the two-axis decision. The fast-path stays for extraction.

### Step 5 — Alias auto-create guard

1. In `ProductAliasAutoCreateService`, short-circuit creation unless both votes are `same`. Log the gate reason so we can audit later.
2. Do not touch source-structured alias imports.

### Step 6 — Diagnostics

1. Add `specIdentityVote`, `nameIdentityVote`, `identitySpecMismatches`, `nameVariantRuleApplied` to `MatchDiagnostics`.
2. Log on every scrape resolution; surface in processing traces.
3. New metric `scrape_resolution_outcome{result=both_same|both_different|spec_overrules|name_overrules|insufficient_fallback}` — lets us see which path carries each decision.

### Step 7 — Backfill / audit

1. One-shot read-only script: for each product with multiple scrape-source rows, run `computeSpecIdentityVote` pairwise. Flag products where any pair returns `different` → candidates for split.
2. Separate script: list auto-created aliases where `computeNameIdentityVote(alias, product.model)` returns `different`. Those are bad merges.
3. Emit CSVs for manual review. No auto-split — data loss risk.

### Step 8 — Tests

1. `SpecComparisonService`: all-match, one-mismatch, insufficient coverage, hierarchy rejection (OLED vs QD-OLED is `different`), tolerance rejection (27" vs 28" is `different`).
2. Name-identity: appendage-rule acceptance (`37G800A` ↔ `37G800A-B`), suffix-difference rejection (`PG32UCDMZ` ↔ `PG32UCDMR`), prefix-only rejection (`PG32UCDM` ↔ `PG32UCDMZ` — should be `different` without an explicit alias).
3. Integration: `ProductScrapeUpdaterService.spec.ts` cases for A, B, C using fixtures derived from the real HTML examples.

### Step 9 — Rollout

1. Flag: `resolution.scrape.useTwoAxisDecision`, default off.
2. Enable for monitors first (richest specs, best-tested). Watch the new metric for a few days.
3. When `both_same` and `both_different` outcomes match manual spot checks, enable per-category as `identitySpecs` lists get populated.

## Trade-offs

- **Case C variants with identical specs across all declared identity specs and a prefix-only name difference** (e.g. PG32UCDM vs PG32UCDMZ — same everything, stand and USB differ) rely on the name `different` vote. As long as we do **not** enable a prefix-match variant rule, these stay separate. Cost: the rare case where a manufacturer ships "PG32UCDM" and later renames its successor to "PG32UCDMX" with no other differences can't be auto-merged; that's acceptable — require an explicit alias.
- **Sources that omit identity specs.** If scrape input has only 2 of 5 identitySpecs, spec vote is `insufficient` and we lean on name alone. This is today's behaviour — no regression, but Case A won't be rescued until specs are richly extracted. Track `insufficient_fallback` in metrics to see if the coverage assumption holds in practice.
- **Config maintenance.** One new list per category. Manageable — categories already carry `primarySpecs`, `matcherSpecs`, hierarchies, `numericTokenRules`. One more focused list for a meaningful reliability win.
- **Alias variant-rule scope.** The trailing-region-code rule is narrow on purpose. If we find more legitimate variant patterns (e.g. generation-suffix `v2`, `gen2`), add them as discrete rules, not a loose Levenshtein threshold.

## What this does not address

- **LLM comment extraction** — untouched except for the optional spec-identity *reject* check. Keep names authoritative there.
- **Brand-level ambiguity** — assumed already filtered by `BrandResolutionService`.
- **Cross-category same-name collisions** — preResolvedCategories already constrains this.
