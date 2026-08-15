# Declarative Scraping System — Implementation Guide

## What changed, in one sentence

Scraping used to be hardcoded per source (a TypeScript class per site, dispatched via `source.type` switch statements). It's now data-driven: every source's fetch/parse/map behavior lives in one JSONB column (`ProductSource.config`), interpreted at runtime by a single generic engine (`libs/scrape-interpreter`). Adding a new source is (in principle) inserting a row, not writing code.

This guide is a reading order. Each section names the file(s) to open, what they do, and how they connect to the next one. Read top to bottom and you'll have traced one full scrape from "cron fires" to "row saved in Postgres."

---

## 1. The `ProductSource` entity — where a source's identity and behavior live

**File:** `libs/database/src/lib/postgres/models/product-source.entity.ts`

This is the root of everything. Each row is one scrapable source (today: Arukereso, DisplaySpecs). Key fields:

- `name` — the source's identity. There is **no more `type` enum** — `name` is now the only discriminator, used everywhere for logging/metrics/lookups.
- `config: ProductSourceConfig` (jsonb) — the entire declarative definition of how to scrape this source: where to fetch from, how to discover products, how to parse list/detail pages, how to map specs. This is the payload the rest of the system interprets.
- `seller?: Seller` — optional link if this source *is* a single seller's own storefront (nullable — aggregator/reference sites like Arukereso/DisplaySpecs aren't any one seller).
- `maxConcurrent`, `requestsPerHour`, `priority`, `schedulingEnabled`, `processingEnabled` — scheduling/throttling knobs, unchanged from before.
- `fullSyncInterval` / `nextFullSyncAt` / `incrementalSyncInterval` / `nextIncrementalSyncAt` — two independent cron-like schedules per source (full catalog crawl vs. incremental "what's new" search).

**Why read this first:** everything downstream is either producing a `ProductSource` row, reading its `config`, or scheduling work against it.

---

## 2. The config shape — `ProductSourceConfig`

**File:** `libs/database/src/lib/postgres/types/product-source-config.ts`

This is the TypeScript type for the JSONB blob. Its top-level shape:

```ts
interface ProductSourceConfig {
  baseUrl: string;
  fullSyncStartUrl?: string;
  discovery?: { mode: 'categoryTitleMatch' | 'brandNameMatch'; linkPipeline: ScrapeOperation[] };
  categories?: Record<string, { enabled: boolean; sourceTitle?: string }>;
  incrementalSync?: { searchKeywords?: string[]; numResults?: number; urlClassify?: { detailUrlPattern: string } };
  listPage: { categoryName: ScrapeOperation[]; categoryLinks: ScrapeOperation[]; productLinks: ScrapeOperation[] };
  detailPage: {
    rawSpecs: ScrapeOperation[];
    category: { breadcrumbOrSource: ScrapeOperation[]; slugLookup: CategoryLookupRule[] };
    brand: ScrapeOperation[];
    model: ScrapeOperation[];
    aliases?: ScrapeOperation[];
    releaseYear?: ScrapeOperation[];
    images: ScrapeOperation[];
    specMapping: Record<string, SourceSpecConfig>; // keyed by category slug
    offers?: { listItems: ScrapeOperation[]; sellerName: ScrapeOperation[]; price: ScrapeOperation[]; ... };
    translation?: { enabled: boolean; sourceLanguage: string; targetLanguage: string; contextTemplate: string };
  };
}
```

Everything under `listPage`/`detailPage`/`discovery` is a **pipeline** — an ordered array of operations (`ScrapeOperation[]`) that gets executed against the fetched HTML. That op vocabulary is the next thing to understand.

**See the real thing:** `libs/scrape-interpreter/src/lib/interpreter/__fixtures__/arukereso.config.json` and `displayspecs.config.json` — the two actual production configs, hand-authored to reproduce everything the old per-source code did.

---

## 3. The operation vocabulary — what a pipeline step can say

**File:** `libs/database/src/lib/postgres/types/scrape-operation.ts`

This defines every op type (`selectAll`, `selectText`, `regexCapture`, `stripPattern`, `extractSpecTableV1`, `generatePaginationLinks`, `branch`, etc. — ~35 in total). Each op is a small JSON object like:

```json
{ "op": "selectText", "selector": "h1.category-title", "first": true, "trim": true }
```

Ops read from and write to a **shared execution context** (`vars`), so a pipeline is really a small program: select something → store it as `as: "someVar"` → a later op reads it via `on: "someVar"` or `{{someVar}}` string interpolation. There's no arbitrary code execution — every op is a named, closed operation from this file.

**Why this matters:** if you ever need to add a new scraping capability (e.g. a new DOM pattern a future source needs), this is where you'd add a new op type — and it needs a matching handler in step 4.

---

## 4. The interpreter engine — what actually runs a pipeline

**Directory:** `libs/scrape-interpreter/src/lib/interpreter/`

This is the new library that turns config + HTML into structured data. Read it in this order:

1. **`scrape-interpreter.service.ts`** — the public facade. Four methods: `runListPage`, `runDetailPage`, `runDiscovery`, `classifyIncrementalUrl`. This is the only class the rest of the app calls into. Note the strict ordering inside `runDetailPage`: raw specs are extracted first, then category is resolved (because category rules can inspect specs — e.g. "headphones vs. headsets" depends on a spec value), then brand/model/images run (they can reference the resolved category name via `{{categoryName}}`).
2. **`services/scrape-pipeline-runner.service.ts`** — executes one `ScrapeOperation[]` array left-to-right against a context, threading `vars`. Also handles `PipelineHalt` — a couple of ops (`assertContains`, `filterByNonEmpty`) can short-circuit the *entire* pipeline early, not just their own step (mirrors an early `return` in the old hand-written code, e.g. "if this isn't page 1, produce no pagination links at all").
3. **`services/scrape-op-registry.service.ts`** — a name → handler map. `ops/register-ops.ts` populates it at module init with every op's implementation function.
4. **`ops/*.ts`** — the actual op implementations, grouped by kind: `selection-ops.ts`, `string-ops.ts`, `regex-ops.ts`, `filter-ops.ts`, `link-ops.ts`, `spec-table-ops.ts`, `image-ops.ts`, `value-map-ops.ts`, `control-ops.ts`.
5. **`services/runtime-data-provider.service.ts`** — the escape hatch for the two things a pipeline can't get purely from the DOM: the list of known brand names (`getBrandNames`, backed by `BrandCacheService`) and category-slug → `ProductCategory` entity lookup (`getCategoryBySlug`, backed by `ProductCategoryRepository`). Referenced in configs via `"source": "runtime:brandCache"` etc. — a small, fixed, reviewable set, not arbitrary DB access.

**Mental model:** `ScrapeInterpreterService` is a pure function of `(task, cheerio-loaded-HTML, config) → structured result`. It never fetches HTML itself and never talks to `TranslationService`/`SpecExtractionService` — those integrations happen one layer up, in step 6.

---

## 5. How a source's config gets exercised, without a network call

**Directory:** `libs/scrape-interpreter/src/lib/interpreter/__fixtures__/`

Before touching the live pipeline, look at the tests here — they're the best way to see the interpreter in action against realistic (hand-written, not live-fetched) HTML:

- `arukereso-detail-page.spec.ts` / `displayspecs-detail-page.spec.ts` — feed synthetic HTML through `runDetailPage` with the *real* production config, assert the exact `brand`/`model`/`categorySlug`/`rawSpecs`/`imageUrls` output.
- `arukereso-list-page.spec.ts` / `displayspecs-discovery.spec.ts` — same idea for list-page parsing and source discovery.
- `config-validation.spec.ts` — structural check: every `op` name referenced anywhere in both real configs actually exists in the op registry, and both configs' `category.slugLookup` rules resolve to the expected slugs.

These are the closest thing to living documentation for "what does this config actually produce."

---

## 6. Where fetched HTML enters the interpreter — the two scraper services

**Files:**
- `libs/product-scraper/src/lib/product-scraper/services/product-list-page-scraper.service.ts`
- `libs/product-scraper/src/lib/product-scraper/services/product-details-page-scraper.service.ts`

These are the two services that actually get invoked per `ScrapeTask`. Both:
1. Fetch HTML via `ScraperService.getHtml(task.url)` (unchanged — still backed by the Zyte API, see `libs/zyte`).
2. `cheerio.load()` it.
3. Call the interpreter (`runListPage` or `runDetailPage`) with `task.source.config`.
4. Do something with the result.

`ProductListPageScraperService` turns the interpreter's `{categoryName, categoryLinks, productLinks}` into new `ScrapeTask` rows (pagination → more list tasks, product links → detail tasks), deduping via `ScrapeUrlDeduplicationService`.

`ProductDetailsPageScraperService` is the more involved one — it's also where the interpreter's raw output gets turned into a finished `ScrapedProduct`:
1. Calls `interpreter.runDetailPage(...)`.
2. Checks `categorySlug` was resolved and is `enabled` in `config.categories`.
3. Resolves the category slug to a real `ProductCategory` entity via `RuntimeDataProviderService`.
4. Loads the category's JSON schema (`CategoryConfigService.getJsonSchema` — **this one thing stayed file-based**, see step 9).
5. **Translation**: reads `config.detailPage.translation`, and if enabled, calls `SpecTranslationSelectorService.collectTranslatableValues()` (which values are worth translating — skips numeric-mode specs and values already resolved by a `valueMap`) then `TranslationService.translateBatch()` (LLM-backed, cached). The interpreter itself never touches translation — this is a deliberate layering decision (DOM-parsing should stay pure; translation is a metered external call).
6. Calls `SpecExtractionService.extractSpecs()` — the **unchanged** engine that turns raw label/value pairs into canonical `ProductSpecs`, using `config.detailPage.specMapping[categorySlug]` (the same `SourceSpecMapping[]`/`extract` mode/`valueMap` system as before — see step 9).
7. Assembles the final `ScrapedProduct` and hands it to `ProductScrapeUpdaterService` (step 8).

---

## 7. What replaced the per-source dispatch switches

**Files:**
- `apps/product-collector/src/modules/queue-processor/scrape-task/scrape-task-processor.service.ts` — replaces the old `ArukeresoQueueProcessorService`/`DisplayspecsQueueProcessorService`. Routes purely by `task.queue` (list vs. detail), no source branching at all.
- `libs/product-scraper/src/lib/product-scraper/services/generic-product-source-sync.service.ts` — replaces `ArukeresoSyncService`+`ArukeresoIndexPageService`+`DisplayspecsSyncService`+`DisplaySpecsIndexPageService` (four classes → one). Fetches the discovery page (`config.fullSyncStartUrl ?? config.baseUrl`), calls `interpreter.runDiscovery(...)`, creates one `ScrapeProductList` task per discovered link.
- `libs/product-scraper/src/lib/incremental-sync/incremental-sync.service.ts` — searches Exa for each of `config.incrementalSync.searchKeywords`, then classifies each result URL via `interpreter.classifyIncrementalUrl(url, config)` (regex from `config.incrementalSync.urlClassify.detailUrlPattern`) instead of a per-source `UrlClassifier` class.

All three read `source.config`/`source.name` — none of them know or care whether they're looking at Arukereso or DisplaySpecs or a future third source.

---

## 8. Persistence — where a `ScrapedProduct` becomes database rows

**File:** `libs/product-scraper/src/lib/product-scraper/services/product-scrape-updater.service.ts`

This service was already the persistence core before this change and is mostly unchanged in shape — the main addition is Offer/Seller handling. Flow:

1. `resolveProductIdentity` — is this a known product (fast normalized-name match) or does it need the full fuzzy/embedding/LLM resolution pipeline (`libs/resolution`)?
2. `persistProduct` — create or update the `ProductModel`, write the per-source `ProductModelSource` row (now via `source: ProductSource` FK instead of a `type` enum — see step 10), re-merge specs across all sources by `ProductSource.priority`.
3. `applyPostSaveSideEffects` — slug generation, alias insertion, image copying to Bunny CDN, and (new) **`createOrUpdateOffers`**.

**`createOrUpdateOffers`** (new): if `scrapedProduct.offers` is populated, for each entry it resolves/creates a `Seller` via `SellerResolutionService` (`libs/product/src/lib/services/resolution/seller-resolution.service.ts` — exact-name lookup, create if missing) and upserts an `Offer` via `OfferRepository.upsertFromScrape()` (`libs/database/.../repositories/offer-repository.ts` — keyed on `[seller, sourceListingId]`, preserves `condition` on update, always bumps `lastSeenAt`/`active`). One bad offer doesn't fail the whole scrape — logged and skipped.

**Today this is a no-op for both real sources** — neither `arukereso.config.json` nor `displayspecs.config.json` populates `detailPage.offers`, so `scrapedProduct.offers` is always empty. The plumbing exists so that wiring up real price-table scraping later (most plausible for Arukereso, since it's a price-comparison site) doesn't require another schema change — just populating `offers.listItems`/`sellerName`/`price` in the config.

---

## 9. What stayed exactly as it was

Not everything moved into the JSONB config. Two things were deliberately left alone:

- **`SpecExtractionService`** (`libs/product/src/lib/services/product-spec/spec-extraction.service.ts`) — the engine that interprets `SourceSpecMapping[]`/`CalculatedSpecRule[]` (label→key mapping, the 12 `extract` modes like `number`/`cmToInchList`/`regexpList`, calculated specs like `presentIfKey`/`featureSearch`). This was already pure declarative JSON consumption before this change; only *where the mapping JSON lives* changed (moved from `libs/config/src/lib/categories/<slug>/specMappings.json` into `config.detailPage.specMapping[slug]` on each `ProductSource`).
- **`CategoryConfigService`** (`libs/config/src/lib/services/category-config.service.ts`) — still file-based, still loads `libs/config/src/lib/categories/<slug>/{config.json,jsonSchema.json,uiSchema.json}` from disk. This is genuinely per-**category** (the canonical spec schema, shared across every source), not per-source parsing config, so it didn't belong in `ProductSource.config`. Its `getSpecMappings*`/`writeSpecMappings` methods *were* removed (that content moved to per-source config) — everything else is untouched.

---

## 10. The one structural fix threaded through everything: no more `ProductSourceType`

There used to be a 3-value enum (`arukereso | displaySpecs | manual`) used as an identity/grouping key in several places. It's gone. Wherever code used to switch or group on `.type`, it now uses either:
- the actual `ProductSource` row (via a new FK — `ProductModelSource.source`, `Offer.source`), or
- `ProductSource.name` as a plain string (for Prometheus metric labels — cardinality stays bounded because sources are added deliberately, not per-request).

The one exception worth knowing about: **admin-entered specs** (via the product-edit UI) have no `ProductSource` at all — `ProductModelSource.source` is `null` for those rows, which is now the signal that used to be `type === 'manual'`. See `ProductUpdateMapperService.mapManualSpecs` (`libs/product/src/lib/services/update/product-update-mapper.service.ts`).

---

## Putting it together — one full trace, source-agnostic

```
cron (ProductSourceSyncScheduler, every minute)
  → finds a ProductSource due for sync, publishes a Task row
  → TaskManagerService (5s poll) claims it, hands to ProductSourceSyncListener
  → ProductSourceSyncListener locks the ProductSource row, calls either:
      - IncrementalSyncService.sync()          (Exa search + interpreter.classifyIncrementalUrl)
      - GenericProductSourceSyncService.sync()  (fetch discovery page + interpreter.runDiscovery)
  → creates ScrapeProductList ScrapeTask row(s)

ScrapeTaskManagerService (5s poll, separate loop)
  → claims a ScrapeTask, hands to ScrapeTaskProcessorService
  → routes by task.queue:
      ScrapeProductList    → ProductListPageScraperService.scrapeListPage(task)
                                → fetch HTML, interpreter.runListPage(task, $, task.source.config)
                                → creates more ScrapeProductList (pagination) + ScrapeProductDetails tasks
      ScrapeProductDetails  → ProductDetailsPageScraperService.scrapeProductDetailsPage(task)
                                → fetch HTML, interpreter.runDetailPage(task, $, task.source.config)
                                → resolve category entity, translate specs, SpecExtractionService.extractSpecs()
                                → assemble ScrapedProduct
                                → ProductScrapeUpdaterService.createOrUpdateProduct(task, scrapedProduct)
                                    → resolve/create ProductModel, write ProductModelSource, merge specs
                                    → slug, aliases, images
                                    → createOrUpdateOffers (no-op today for both real sources)
```

Every arrow in that diagram is source-agnostic — the only thing that varies between Arukereso and DisplaySpecs is the JSON sitting in `ProductSource.config`.

---

## If you want to add a third source

1. Author a new `ProductSourceConfig` JSON (copy the shape from `arukereso.config.json` or `displayspecs.config.json` depending on whether the new source is more "aggregator-with-price-table" or "spec-reference-site" shaped).
2. Write golden-fixture tests for it under `libs/scrape-interpreter/src/lib/interpreter/__fixtures__/`, following the pattern in step 5.
3. If (and only if) the source needs a genuinely new kind of DOM pattern the current ~35 ops can't express, add a new op: type in `scrape-operation.ts`, handler in the matching `ops/*.ts` file, registration in `ops/register-ops.ts`.
4. Insert a `ProductSource` row with the new config (see `apps/product-collector/scripts/seed-product-source-configs.ts` for the pattern).
5. No other code changes needed — the scheduler, task managers, scraper services, and persistence layer all already work off `source.config`/`source.name`.
