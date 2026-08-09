# Plan — Source-Anchored Product Identity for Scrape Resolution

## Problem recap

Scraping resolution conflates two distinct questions today:

1. *"Is this scrape from source S the same product as another scrape from source S?"* — **same-source question**. A single catalog does not list the same product twice under different model codes. If arukereso shows `PG32UCDMZ` and `PG32UCDMR`, those are different products by definition.
2. *"Is this scrape from source A the same product as a scrape from source B?"* — **cross-source question**. Names may differ (short SKU vs full marketing name, regional suffix, product-line prefix); specs are the authoritative signal.

Today's matcher treats both questions with the same rules, which is why we see:

- **Case A (false split)** — `LG 37G800A` (displayspecs) vs `LG UltraGear 37G800A-B` (arukereso): same product, different sources, name suffix gate rejects.
- **Case B (false merge)** — `PG32UCDMR` scraped on arukereso gets merged onto `PG32UCDMZ` (already arukereso): alias auto-create + exact-alias fast path stamp the wrong alias.
- **Case C (would-be false merge)** — `PG32UCDP`, `PG32UCDMZ`, `PG32UCDMR`, `PG32UCDM` all on arukereso, nearly-identical specs, distinguishable only by suffix chars in the model code.

The insight: **same-source** and **cross-source** have opposite resilient signals. Same-source trusts the name absolutely (the catalog enforces uniqueness). Cross-source distrusts the name (formatting varies) and leans on specs.

## Proposal

Anchor product identity **per source** via the scraped name, and use specs only for cross-source merging.

### Invariant

> Within a single source, `(source_type, normalized_scraped_name)` identifies a unique `ProductModel`. Two scrapes from the same source with different normalized names are different products — always.

### Two resolution paths

```
scrape arrives (source S, scraped name N, specs P)
        │
        ▼
┌──────────────────────────────────────┐
│ Path 1: same-source lookup (fast)    │
│   SELECT product FROM ProductModelSource │
│   WHERE source_type = S              │
│     AND normalized_source_name = N   │
└──────────────────────────────────────┘
        │
        ├── hit  → update existing product (same SKU, refreshed data)
        │
        └── miss → Path 2
                    │
                    ▼
┌──────────────────────────────────────┐
│ Path 2: cross-source merge check     │
│   Candidate pool: products with NO   │
│   existing ProductModelSource row    │
│   from source_type = S               │
│   (if they had one, Path 1 would     │
│    have already matched it)          │
│                                      │
│   Accept a candidate only if:        │
│    a) identity specs match exactly   │
│    b) name matches after variant-    │
│       appendage normalization        │
└──────────────────────────────────────┘
        │
        ├── hit  → attach new ProductModelSource row to existing product
        │
        └── miss → create new ProductModel + ProductModelSource row
```

Path 1 handles Cases B and C cleanly: different name in same source → no match → Path 2. Path 2 rejects because specs agree but names differ on non-appendage chars → new product.

Path 2 handles Case A cleanly: displayspecs-side scrape of `LG 37G800A`, candidate PG model with only an arukereso source row → Path 1 miss → Path 2 runs, finds the arukereso-sourced candidate, specs match, name differs only by product-line prefix ("UltraGear") and regional suffix ("-B") → accept.

## Data model

### Change 1 — Store scraped names on `ProductModelSource`

Today [product-model-source.entity.ts](libs/database/src/lib/postgres/models/product-model-source.entity.ts) tracks `type`, `url`, `specs`, `lastUpdated`. Add:

```ts
@Column({ type: 'varchar', nullable: true })
sourceName: string;        // raw scraped name, e.g. "ASUS ROG Swift PG32UCDMZ"

@Index()
@Column({ type: 'varchar', nullable: true })
normalizedSourceName: string;  // normalized for lookup, e.g. "asus rog swift pg32ucdmz"
```

Unique constraint:

```ts
@Unique(['type', 'normalizedSourceName'])
```

(Keep the existing unique index on `url` — both constraints hold.)

**Why not just use `url`?** URLs change when catalogs restructure (e.g. slug rewrites, query-param cleanup). Names are the stable per-source identity.

**Normalization rule for `normalizedSourceName`.** Lowercase, strip punctuation, collapse whitespace. Must be deterministic and stable. Reuse `ProductNormalizerService.normalizeProduct` with `NormalizationMode.SHORT` — it already produces the same form we use for global `ProductModel.normalizedName`.

### Change 2 — Backfill

Migration script (one-off) walks every `ProductModelSource` and populates `sourceName`/`normalizedSourceName` from the corresponding `ProductModel.displayName` (best we have for historical rows; imperfect but fine since the unique constraint is only enforced for new writes until backfill completes). Run backfill, then add the unique constraint via a second migration.

### Change 3 — Drop auto-generated aliases from the scrape pipeline

[ProductAliasAutoCreateService](libs/product-resolution/src/lib/services/product-alias-auto-create.service.ts) creates aliases after a confident match. In the new world:

- Same-source: Path 1 doesn't need aliases — exact name lookup on `ProductModelSource` is the identity.
- Cross-source: when Path 2 merges, we already have the variant name stored on the new `ProductModelSource` row; an alias would be redundant.

Remove auto-alias creation from the scraper flow entirely. `ProductAlias` stays — used by LLM comment-extraction resolution (where users type informal/partial names). That's a separate concern with different failure modes.

Concretely: `ProductScrapeUpdaterService.createOrUpdateProduct` stops calling `aliasAutoCreate` (and `ProductMatcherService.maybeAutoCreateAlias` is guarded to fire only in extraction context).

### Change 4 — Keep source-provided structured aliases

Some sources (DisplaySpecs "Model alias" list, Árukereső parenthesized part numbers) publish authoritative alternate SKUs. These are already captured via `ScrapedProduct.aliases` and inserted with `ProductAliasSource.scraped`. Keep that flow unchanged — it's real data from the source, not inference.

Consider whether these should live on `ProductModelSource` instead of the global `ProductAlias` table (as a `sourceAliases: string[]` column). Arguments both ways; defer — not load-bearing for the fix.

## Resolution service rewrite

### `ProductScrapeUpdaterService.createOrUpdateProduct`

Replace the current lookup cascade (`normalizedName` → `findExistingProductModel` via `ProductSearchAgent`) with:

```ts
// Path 1: same-source exact identity
const existing = await this.productModelSourceRepo.findOne({
  where: {
    type: task.source.type,
    normalizedSourceName: normalizedSourceName,
  },
  relations: ['model', ...relations],
});
if (existing) {
  return this.updateExistingProduct(existing.model, scrapedProduct, task);
}

// Path 2: cross-source merge
const crossSourceMatch = await this.findCrossSourceMatch(scrapedProduct, task);
if (crossSourceMatch) {
  return this.attachSourceRowToExistingProduct(crossSourceMatch, scrapedProduct, task);
}

// Neither: new product
return this.createNewProduct(scrapedProduct, task);
```

### Cross-source matcher (Path 2)

Reuses most of today's `ProductMatcherService` plumbing, with two hard constraints:

1. **Candidate pool excludes products already sourced from this source.** A product that has a `ProductModelSource(type = S)` row cannot match a new scrape from S via Path 2 — if it could, the name would have matched in Path 1. This is the query filter; it cheaply eliminates Case B/C families.
2. **Acceptance requires both spec-identity and name-identity votes to be non-negative** (the two-axis decision from the prior plan, narrowed to cross-source only).

- **Spec-identity vote** — category-declared `identitySpecs` (e.g. monitors: `["screenSize", "resolution", "refreshRate", "panelType", "curvature"]`) must compare exactly (no 5 % tolerance, no hierarchy collapse) on both sides. Returns `same` / `different` / `insufficient`.
- **Name-identity vote** — normalized model codes. `same` if critical tokens match and any suffix difference matches the variant-appendage rule (trailing ≤2 alpha chars on a ≥5-char stem — covers `37G800A-B`, `34GS95QE-B`). `different` otherwise.

Accept on `(spec=same, name=same|insufficient)` or `(spec=insufficient, name=same)`. Reject otherwise. Much shorter decision matrix than the earlier plan because Cases B/C are already off the table.

### Attach semantics

When Path 2 finds a match, we add a new `ProductModelSource` row to the existing `ProductModel` — we do **not** overwrite the existing source's data. The product now has two source rows (e.g. arukereso + displayspecs). Deduplication of conflicting spec values across sources stays within existing `ProductSpecUpdaterService` logic.

## Configuration

### New category config field

```jsonc
// libs/config/src/lib/categories/monitors/config.json
"identitySpecs": ["screenSize", "resolution", "refreshRate", "panelType", "curvature"],
"minIdentitySpecCoverage": 4
```

Added to `CategoryMatchingConfig` in [product-category-config.ts](libs/database/src/lib/postgres/types/product-category-config.ts).

Populated per-category. Empty list = Path 2 falls back to Path-2-today behaviour (no new acceptance signal). Roll out incrementally.

### Variant-appendage rule

Hardcoded global rule in the new name-identity comparator: trailing alpha token of ≤2 chars when stem is ≥5 chars. No per-category config yet — add if a category surfaces a distinct pattern.

## Implementation steps

1. **Entity + migration.** Add `sourceName`, `normalizedSourceName` to `ProductModelSource`. Backfill from `ProductModel.displayName`. Add `@Unique(['type', 'normalizedSourceName'])` after backfill.
2. **Repository query.** Add `ProductModelSourceRepository.findByNormalizedName(type, normalizedName)`.
3. **Category config.** Add `identitySpecs` + `minIdentitySpecCoverage` to the shared config type. Populate for monitors.
4. **Spec-identity comparator.** New `SpecComparisonService.computeSpecIdentityVote()` — exact equality, no tolerance, no hierarchy collapse, coverage-aware.
5. **Name-identity comparator.** New helper beside `token-parser.ts` — compares two `ParsedModelCode`s using the variant-appendage rule.
6. **Rewrite `ProductScrapeUpdaterService.createOrUpdateProduct`.** Path 1 → Path 2 → create. Path 2 calls a new thin `CrossSourceProductMatcherService` that wraps `ProductSearchAgent` + the two new comparators.
7. **Remove auto-alias creation from scraper flow.** Keep `ProductMatcherService.maybeAutoCreateAlias` for extraction context only (guard on a new `options.context`).
8. **Diagnostics + metrics.** `scrape_resolution_outcome{result=same_source_hit|cross_source_merge|new_product|rejected_same_source|rejected_cross_source}`. Log the two votes on every cross-source decision.
9. **Backfill audit.** Read-only script: for each product with >1 `ProductModelSource` row of the same `type`, flag for review (should be impossible once the unique constraint is live, but we have legacy data). Separate script: for each auto-generated alias, evaluate the name-identity vote against the product's model — flag `different` outcomes as probable bad merges.
10. **Tests.**
    - Path 1: hit on exact name → product reused; no Path 2 call.
    - Path 2 Case A: displayspecs scrape, arukereso-only candidate, specs agree, name via appendage rule → merge.
    - Path 2 Case B prevented by Path 1 exclusion: arukereso scrape of PG32UCDMR when PG32UCDMZ has an arukereso row → Path 2 candidate pool excludes it → new product.
    - Path 2 Case C same: PG32UCDP arukereso scrape when all four variants have arukereso rows → all excluded from Path 2 pool → new product.
    - Normalizer idempotence: `"ASUS ROG Swift PG32UCDMZ"` and `"asus  rog   swift pg32ucdmz  "` produce identical `normalizedSourceName`.
11. **Rollout.** Flag `resolution.scrape.useSourceAnchoredIdentity`, default off. Enable for one source (arukereso) first, watch metrics for a day, then enable globally.

## Trade-offs and edge cases

- **Catalog renames within one source.** If arukereso changes `PG32UCDMZ` to `PG32UCDMZ-B` under the same URL, the URL unique index still finds the row, but `normalizedSourceName` now diverges. Need a policy: on URL hit, update the stored `normalizedSourceName`. Acceptable — catalog renames are rare and the URL is the stronger per-row identity.
- **Product moves URL but keeps name.** Path 1 finds by name → same product, URL updated. Correct behaviour.
- **Product splits on source.** If arukereso starts listing `PG32UCDMZ` as two separate pages (e.g. a retail and an OEM variant), the first creates a row, the second fails the unique constraint. Handle by detecting the constraint violation and creating a new ProductModel. Matches current behaviour for `normalizedName` conflicts in `saveProductModel`.
- **Extraction path unchanged.** LLM resolution still uses name-first matching through `ProductAlias` and today's gates. No regression risk in that pipeline.
- **Sources beyond today's two.** Scales naturally — each source enforces its own identity via the unique constraint; cross-source merging uses specs + appendage rule.
- **`normalizedSourceName` vs `ProductModel.normalizedName`.** Separate fields on purpose: `ProductModel.normalizedName` is the canonical global name (what we show, what we search), chosen at merge time. `normalizedSourceName` is per-source, immutable per scrape, the identity anchor for that specific source. They can diverge when a product is known by different names on different catalogs — which is the whole point.

## What this does not address

- LLM comment extraction resolution — deliberately left alone.
- Cross-source spec disagreement (different brightness across sources) — handled by existing spec-update logic, not in scope.
- Bad historical merges — the audit script in step 9 surfaces them; manual cleanup.

## Summary of changes vs. `PLAN-scrape-dedup-reliability.md`

- **Drops** the generic two-axis decision for all scrape cases.
- **Adds** `ProductModelSource.sourceName` + `normalizedSourceName` + unique constraint as the primary identity anchor.
- **Narrows** the spec+name vote to Path 2 (cross-source) only — where names genuinely vary.
- **Removes** scraper-side auto-alias creation entirely (was the root cause of Case B).
- **Keeps** `identitySpecs` config and the variant-appendage rule — still needed for cross-source merges.
