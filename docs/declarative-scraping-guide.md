# Declarative Scraping System — Implementation Guide

## What changed, in one sentence

Scraping used to be hardcoded per source (a TypeScript class per site, dispatched via `source.type` switch statements). It's now data-driven: every source's fetch/parse/map behavior lives in one JSONB column (`ProductSource.config`), interpreted at runtime by a single generic engine (`libs/scrape-interpreter`). Adding a new source is (in principle) inserting a row, not writing code.

> **A second import type landed after this guide was written.** `ProductSource.type` is `'scraping' | 'arukereso'` — see §1 and §10, both of which used to say the type column was gone. Everything below describes the `scraping` type unless it says otherwise; an `arukereso` source imports a product feed instead of walking pages, with its own config shape and no page pipelines at all.

This guide is a reading order. Each section names the file(s) to open, what they do, and how they connect to the next one. Read top to bottom and you'll have traced one full scrape from "cron fires" to "row saved in Postgres."

---

## 1. The `ProductSource` entity — where a source's identity and behavior live

**File:** `libs/database/src/lib/postgres/models/product-source.entity.ts`

This is the root of everything. Each row is one importable source (today: `ebikeshop` scraping pages, `speedbike-arukereso` importing a feed). **One webshop may have several sources** — `ProductSourceRecord` is unique on `(source, url)` and every URL-keyed lookup is source-scoped, so each source keeps its own records; the offers converge through `Offer`'s `(seller, externalId)` unique constraint. Key fields:

- `name` — the source's identity, and the label on every log line and metric.
- `type` — `'scraping'` or `'arukereso'`. **Fixed at creation**: the config format is bound to it, the two shapes share no keys, and `ProductSourceUpdateService` refuses an update that changes it. It selects both the config schema and the importer.
- `config: ProductSourceConfig` (jsonb) — the entire declarative definition. Which shape it takes is decided by `type`, so it is a discriminated pair rather than one document with a mode flag.
- `seller: Seller` — the storefront every offer from this source belongs to. Non-nullable; there is no per-offer seller in the pipeline.
- `maxConcurrent`, `requestsPerHour`, `priority`, `schedulingEnabled`, `processingEnabled` — scheduling/throttling knobs. On a feed source they govern nothing: a feed run is one HTTP GET and enqueues no tasks.
- `frequency` / `nextRunAt` — how often this source runs, and when it is next due. Runs are **started overnight, 02:00–06:00 Europe/Budapest**; `nextRunAt` is always snapped into that window, with jitter so ten shops do not all start at 02:00.

**Why read this first:** everything downstream is either producing a `ProductSource` row, reading its `config`, or scheduling work against it.

---

## 2. The config shape — `ProductSourceConfig`

**File:** `libs/database/src/lib/postgres/types/product-source-config.ts`

This is the TypeScript type for the JSONB blob. Its top-level shape:

`ProductSourceConfig` is a **discriminated pair selected by `ProductSource.type`**, not a union inside the document — the type lives on the entity, so repeating it in the config would be a second claim about the same fact.

### `type: 'scraping'`

```ts
interface ScrapingSourceConfig {
  baseUrl: string;
  startUrls: string[];            // replaced fullSyncStartUrl + the old `discovery` block
  categoryLinks?: ScrapeOperation[];  // only when a start URL is a hub page
  categories?: Record<string, { enabled: boolean; sourceTitle?: string }>;
  listPage: {
    categoryName: ScrapeOperation[];
    // Evaluated ONCE per run by the importer against page 1, never by a list
    // page itself — see §7.
    pagination?: { urlTemplate: string; pageCount: ScrapeOperation[] };
    items: ScrapeOperation[];
    itemMode: 'cheerio' | 'json';
    itemPipeline: ScrapeOperation[];  // terminates in assembleListProduct
  };
  detailPage: {
    rawSpecs: ScrapeOperation[];
    category: { breadcrumbOrSource: ScrapeOperation[]; slugLookup: CategoryLookupRule[] };
    brand: ScrapeOperation[];
    model: ScrapeOperation[];
    aliases?: ScrapeOperation[];
    releaseYear?: ScrapeOperation[];
    images: ScrapeOperation[];
    specMapping: Record<string, SourceSpecConfig>; // keyed by category slug
    offers?: { offerList: ScrapeOperation[]; itemMode: 'cheerio' | 'json'; itemPipeline: ScrapeOperation[] /* terminates in assembleOffer */ };
    translation?: { enabled: boolean; sourceLanguage: string; targetLanguage: string; contextTemplate: string };
  };
}
```

Everything under `listPage`/`detailPage` is a **pipeline** — an ordered array of operations (`ScrapeOperation[]`) that gets executed against the fetched HTML. That op vocabulary is the next thing to understand.

### `type: 'arukereso'`

```ts
interface ArukeresoSourceConfig {
  baseUrl: string;
  feedUrl: string;                 // fetched over plain HTTP, never through the paid scraper
  format?: 'auto' | 'xml' | 'csv';
  csv?: { delimiter?: 'auto' | ',' | ';' | '\t' };
  categories?: Record<string, { enabled: boolean; sourceTitle?: string }>;
  category: { labelFrom?: ScrapeOperation[]; slugLookup: CategoryLookupRule[] };
  mapping: Record<ArukeresoMappingTarget, { field?: string; pipeline?: ScrapeOperation[] }>;
  specMapping?: Record<string, SourceSpecConfig>;  // same shape as detailPage.specMapping
  postProcess?: ProductSourcePostProcessConfig;    // the same block, read by the same service
}
```

Small on purpose: `field` does the addressing and the op pipeline does the transforming, which is why this type needs **no scrape ops of its own**. The mapping targets are a closed set (`ARUKERESO_MAPPING_TARGETS`) asserted by the schema, so a typo'd target is refused rather than silently ignored. `category` is required here though its scraping counterpart is optional — a feed is the whole catalogue, so a source that cannot categorise an item can import nothing at all.

**See the real thing:**
- `__fixtures__/ebikeshop.config.json` — scraping, JSON-hydration/Inertia `data-page` markup.
- `__fixtures__/speedbike.config.json` — scraping, classic `<table>` spec extraction. Kept as a style template; speedbike itself is feed-only, so this config has no source row.
- `__fixtures__/speedbike-arukereso.config.json` — the feed config, reusing that file's 58 spec mappings unchanged, because a feed's `attribute_name` labels are the same labels the shop's own spec table uses.

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

1. **`scrape-interpreter.service.ts`** — the public facade. Three methods: `runListPage`, `runDetailPage`, `runDiscovery`. This is the only class the rest of the app calls into. Note the strict ordering inside `runDetailPage`: raw specs are extracted first, then category is resolved (because category rules can inspect specs — e.g. "headphones vs. headsets" depends on a spec value), then brand/model/images run (they can reference the resolved category name via `{{categoryName}}`).
2. **`services/scrape-pipeline-runner.service.ts`** — executes one `ScrapeOperation[]` array left-to-right against a context, threading `vars`. Also handles `PipelineHalt` — a couple of ops (`assertContains`, `filterByNonEmpty`) can short-circuit the *entire* pipeline early, not just their own step (mirrors an early `return` in the old hand-written code, e.g. "if this isn't page 1, produce no pagination links at all").
3. **`services/scrape-op-registry.service.ts`** — a name → handler map. `ops/register-ops.ts` populates it at module init with every op's implementation function.
4. **`ops/*.ts`** — the actual op implementations, grouped by kind: `selection-ops.ts`, `string-ops.ts`, `regex-ops.ts`, `filter-ops.ts`, `link-ops.ts`, `spec-table-ops.ts`, `image-ops.ts`, `value-map-ops.ts`, `control-ops.ts`.
5. **`services/runtime-data-provider.service.ts`** — the escape hatch for the two things a pipeline can't get purely from the DOM: the list of known brand names (`getBrandNames`, backed by `BrandCacheService`) and category-slug → `ProductCategory` entity lookup (`getCategoryBySlug`, backed by `ProductCategoryRepository`). Referenced in configs via `"source": "runtime:brandCache"` etc. — a small, fixed, reviewable set, not arbitrary DB access.

**Mental model:** `ScrapeInterpreterService` is a pure function of `(task, cheerio-loaded-HTML, config) → structured result`. It never fetches HTML itself and never talks to `TranslationService`/`SpecExtractionService` — those integrations happen one layer up, in step 6.

---

## 5. How a source's config gets exercised, without a network call

**Directory:** `libs/scrape-interpreter/src/lib/interpreter/__fixtures__/`

Before touching the live pipeline, look at the tests here — they're the best way to see the interpreter in action against realistic (hand-written, not live-fetched) HTML:

- `ebikeshop-detail-page.spec.ts` / `speedbike-detail-page.spec.ts` — feed synthetic HTML through `runDetailPage` with the *real* production config, assert the exact `brand`/`model`/`categorySlug`/`rawSpecs`/`imageUrls` output.
- `ebikeshop-list-page.spec.ts` — same idea for list-page parsing.
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
- `apps/product-collector/src/modules/queue-processor/scrape-task/scrape-task-processor.service.ts` — replaces the old per-source queue processor classes. Routes purely by `task.queue` (list vs. detail), no source branching at all.
- `libs/product-scraper/src/lib/product-scraper/services/scraping-import.service.ts` — the `scraping` importer. Replaced `GenericProductSourceSyncService`, whose whole job was running a `config.discovery` block to *find* start URLs; neither live config ever had one, so a "full sync" silently did nothing. `startUrls` names them outright.
- `libs/product-scraper/src/lib/arukereso/arukereso-import.service.ts` — the `arukereso` importer, resolved through `ProductSourceImporterRegistry` by `source.type`.

**Category expansion and pagination are resolved once per run, by the importer — never by a list page.** That is not a style preference: `generatePaginationLinks` had no page-1 guard and task creation did not dedupe, so a self-paginating listing re-emitted its whole page range from every page it landed on. Both live configs had to leave `categoryLinks` empty to work around it. A list-page task is now a pure "parse the items here" unit with no power to enqueue more pages, which makes that whole class of bug structurally impossible rather than guarded against.

The task processor reads `source.config` and does not know which source it is looking at; the importers are selected by `source.type` and nothing else.

---

## 8. Persistence — where a `ScrapedProduct` becomes database rows

**File:** `libs/product-scraper/src/lib/product-scraper/services/product-scrape-updater.service.ts`

This service was already the persistence core before this change and is mostly unchanged in shape — the main addition is Offer/Seller handling. Flow:

1. `resolveProductIdentity` — is this a known product (a stored id: the task, an offer externalId, a source externalId) or does it need listing matching (`libs/product-identity`, Path 4: name score, spec gates, and the LLM only for the near-misses)?
2. `persistProduct` — create or update the `ProductModel`, write the per-source `ProductModelSource` row (now via `source: ProductSource` FK instead of a `type` enum — see step 10), re-merge specs across all sources by `ProductSource.priority`.
3. `applyPostSaveSideEffects` — slug generation, alias insertion, image copying to Bunny CDN, and (new) **`createOrUpdateOffers`**.

**`createOrUpdateOffers`**: if `scrapedProduct.offers` is populated, for each entry it takes the seller from the source's own `ProductSource.seller` and upserts an `Offer` via `OfferRepository.upsertFromScrape()` (`libs/database/.../repositories/offer-repository.ts` — keyed on `[seller, externalId]`, preserves `condition` on update, always bumps `lastSynced`/`active`). One bad offer doesn't fail the whole scrape — logged and skipped.

Two things here are load-bearing and easy to miss, because **the `(seller, externalId)` unique constraint does not error on a collision — it keeps the last writer**:

- **`externalId` is resolved for the whole page at once.** A source-native id when there is one, otherwise the URL slug (derived in shared code, so a scraping source and a feed source for one shop land on the same string — that is how they converge on one offer). Any value claimed by more than one offer on the page is dropped for all of them: otherwise three size variants at one URL would collapse into ONE offer row, with nothing logged.
- **The conflict branch is cross-source adoption, not rare concurrency.** Offers are preloaded per *source*, so a second source importing a listing the first already owns cannot see that row, conflicts on insert, and adopts it. If the two sources resolved *different* products for the listing, it throws `OfferIdentityConflictError` rather than rebinding (which would silently move a listing) or leaving it (which would silently strand the other model with no offer, hence no price).

Both feed `offer_identity_conflict_total{source,kind}`.

Both `ebikeshop.config.json` and `speedbike.config.json` populate `detailPage.offers` today, so this runs on every scrape for those sources — a single-seller storefront config populates `offers.listItems`/`price` (and, for ebikeshop, `priceWithoutDiscount`) directly from its own listing/price markup. Seller is never scraped per offer — every offer belongs to its `ProductSource.seller`.

---

## 9. What stayed exactly as it was

Not everything moved into the JSONB config. Two things were deliberately left alone:

- **`SpecExtractionService`** (`libs/product/src/lib/services/product-spec/spec-extraction.service.ts`) — the engine that interprets `SourceSpecMapping[]`/`CalculatedSpecRule[]` (label→key mapping, the 12 `extract` modes like `number`/`cmToInchList`/`regexpList`, calculated specs like `presentIfKey`/`featureSearch`). This was already pure declarative JSON consumption before this change; only *where the mapping JSON lives* changed (moved from `libs/config/src/lib/categories/<slug>/specMappings.json` into `config.detailPage.specMapping[slug]` on each `ProductSource`).
- **`CategoryConfigService`** (`libs/config/src/lib/services/category-config.service.ts`) — still file-based, still loads `libs/config/src/lib/categories/<slug>/{config.json,jsonSchema.json,uiSchema.json}` from disk. This is genuinely per-**category** (the canonical spec schema, shared across every source), not per-source parsing config, so it didn't belong in `ProductSource.config`. Its `getSpecMappings*`/`writeSpecMappings` methods *were* removed (that content moved to per-source config) — everything else is untouched.

---

## 10. `ProductSourceType`, twice — and they are not the same thing

**Read this if §1's `type` field surprised you.** There have been two different things called `ProductSourceType`, and conflating them will send you in the wrong direction.

The **old** one was a 3-value enum (`arukereso | displaySpecs | manual`) used as an identity/grouping key — "which kind of thing produced this data". It is gone, and the rest of this section is about that removal.

The **current** one is `'scraping' | 'arukereso'` and answers a different question: **which importer runs this source, and therefore which shape its config takes**. It is not a grouping key and nothing switches on it for identity — the importer registry resolves it once (`ProductSourceImporterRegistry`), the config validator dispatches the right JSON Schema off it, and that is all. It is fixed at creation because the stored config would otherwise be reinterpreted under a format that shares none of its keys.

That the old name came back for a new meaning is unfortunate. The distinguishing test: the old type grouped *rows by origin*, the new type selects *code by config format*.

---

Wherever code used to switch or group on the OLD `.type`, it now uses either:
- the actual `ProductSource` row (via a new FK — `ProductModelSource.source`, `Offer.source`), or
- `ProductSource.name` as a plain string (for Prometheus metric labels — cardinality stays bounded because sources are added deliberately, not per-request).

The one exception worth knowing about: **admin-entered specs** (via the product-edit UI) have no `ProductSource` at all — `ProductModelSource.source` is `null` for those rows, which is now the signal that used to be `type === 'manual'`. See `ProductUpdateMapperService.mapManualSpecs` (`libs/product/src/lib/services/update/product-update-mapper.service.ts`).

---

## Putting it together — one full trace, source-agnostic

```
cron (ProductSourceSyncScheduler, every 10 min between 02:00–05:59 Europe/Budapest)
  → finds ProductSources due (schedulingEnabled, frequency set, nextRunAt passed)
  → advances nextRunAt at ENQUEUE time, publishes a Task row
  → TaskManagerService (5s poll) claims it, hands to ProductSourceSyncListener
  → validates the config against the schema for source.type, then
      ProductSourceImporterRegistry.get(source.type).import(source)

  ── type 'scraping' ──────────────────────────────────────────────
  ScrapingImportService
    → resolves startUrls → category URLs (categoryLinks, once) → EVERY page
      (pagination.pageCount against page 1, once) and enqueues one
      ScrapeProductList task per page. Then returns; the poller does the rest.

  ── type 'arukereso' ─────────────────────────────────────────────
  ArukeresoImportService
    → one native GET, streamed through ArukeresoFeedParserService, mapped per
      item and persisted inline. Enqueues nothing; there is no page to walk.

ScrapeTaskManagerService (5s poll, separate loop) — scraping only
  → claims a ScrapeTask, routes by task.queue:
      ScrapeProductList    → ProductListPageScraperService.scrapeListPage(task)
                                → interpreter.runListPage → ScrapedListProduct[]
                                → per card, ListProductRefreshService decides:
                                    refresh the offer in place (no detail fetch
                                    spent), or enqueue ScrapeProductDetails.
                                → enqueues NO further list pages, by design
      ScrapeProductDetails → ProductDetailsPageScraperService
                                → interpreter.runDetailPage, spec extraction,
                                  SpecPostProcessService (hash-skipped when
                                  nothing changed)
                                → ScrapedProduct

  ── both types converge here ─────────────────────────────────────
  ProductScrapeUpdaterService.createOrUpdateProduct(context, scrapedProduct)
    → resolve/create ProductModel, write ProductSourceRecord, merge specs
    → slug, aliases, images
    → createOrUpdateOffers (externalId resolved per page, offers stamped
      with lastSynced)
```

Everything below the converge line is import-agnostic: identity resolution, merge, spec validation and offer upsert cannot tell whether a product arrived as HTML or as a feed row. That is what `ProductImportContext` is for — the persistence path used to take a `ScrapeTask`, and a feed run has none.

---

## If you want to add a new source

**Use the `add-webshop` skill** (`.claude/skills/add-webshop/`) — it is the maintained procedure, with a plan/execute split and a human review gate between them. In outline:

0. **Decide the type first.** Probe for a feed before assuming you must scrape: `curl -o /dev/null -w '%{http_code}' 'https://<shop>/api/?route=export/feed&id=arukereso'` (ShopRenter's pattern — 200 enabled, 405 disabled, 401 password-protected). One GET beats thousands of paid page fetches. The type cannot be changed afterwards.
1. Author the config for that type, against the schema `get_product_source_config_schema({ type })` returns. Copy the closest fixture: `ebikeshop.config.json` (JSON-hydration markup), `speedbike.config.json` (classic `<table>`), `speedbike-arukereso.config.json` (feed).
2. Write golden-fixture tests under `libs/scrape-interpreter/src/lib/interpreter/__fixtures__/`, and add the config to `config-validation.spec.ts` — that spec is the pre-deploy gate.
3. Only if the source needs a DOM pattern the current 53 ops cannot express, add one: type in `scrape-operation.ts`, handler in `ops/*.ts`, registration in `ops/register-ops.ts`, name in `SCRAPE_OPERATION_NAMES` (a spec asserts those two agree in both directions).
4. Create the `ProductSource` row with its `type` (see `seed-product-source-configs.ts`), scheduling off.
5. Dry-run it: `simulate_product_source_import({ productSourceId })` reports what a run would do without writing anything — for a feed, how much survives the category gate and whether the chosen `externalId` is unique across it; for a scraping source, the page walk and the per-card refresh-vs-detail-fetch split. Enable scheduling only once that looks right.
6. No other code changes needed — scheduler, task managers, importers and persistence all work off `source.type`/`source.config`.
