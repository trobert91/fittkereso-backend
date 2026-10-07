# Declarative Scraping System — Implementation Guide

## What changed, in one sentence

Scraping used to be hardcoded per source (a TypeScript class per site, dispatched via `source.type` switch statements). It's now data-driven: every source's fetch/parse/map behavior lives in one JSONB column (`ProductSource.config`), interpreted at runtime by a single generic engine (`libs/scrape-interpreter`). Adding a new source is (in principle) inserting a row, not writing code.

> **A second import type landed after this guide was written.** `ProductSource.type` is `'scraping' | 'arukereso' | 'googleshop'` — see §1 and §10, both of which used to say the type column was gone. Everything below describes the `scraping` type unless it says otherwise; an `arukereso` or `googleshop` source imports a product feed instead of walking pages, with its own config shape and no page pipelines at all.

This guide is a reading order. Each section names the file(s) to open, what they do, and how they connect to the next one. Read top to bottom and you'll have traced one full scrape from "cron fires" to "row saved in Postgres."

---

## 1. The `ProductSource` entity — where a source's identity and behavior live

**File:** `libs/database/src/lib/postgres/models/product-source.entity.ts`

This is the root of everything. Each row is one importable source (today: `ebikeshop` scraping pages, `speedbike-arukereso` importing a feed). **One webshop may have several sources** — `ProductSourceRecord` is unique on `(source, externalId)` and every lookup is source-scoped, so each source keeps its own records; the offers converge through `Offer`'s `(seller, externalId)` unique constraint. A record is keyed by its listing's id (§8a), not its URL: when a shop renames a product's URL, the next import moves the record to it. Key fields:

- `name` — the source's identity, and the label on every log line and metric.
- `type` — `'scraping'`, `'arukereso'` or `'googleshop'`. **Fixed at creation**: the config format is bound to it, the scraping and feed shapes share no keys (the two feed types share one), and `ProductSourceUpdateService` refuses an update that changes it. It selects both the config schema and the importer.
- `config: ProductSourceConfig` (jsonb) — the entire declarative definition. Which shape it takes is decided by `type`, so it is a discriminated pair rather than one document with a mode flag.
- `seller: Seller` — the storefront every offer from this source belongs to. Non-nullable; there is no per-offer seller in the pipeline.
- `maxConcurrent`, `requestsPerHour`, `priority`, `schedulingEnabled`, `processingEnabled` — scheduling/throttling knobs. On a feed source they govern nothing: a feed run is one HTTP GET and enqueues no tasks.
- `fetchMode` — how every page and feed of the source is fetched, for every type: `'proxied'` (the default, and what a new source gets) goes through the paid scraping API, Zyte today; `'direct'` calls the shop itself, for free. A shop goes direct only once it agrees to be read, or when a document is over Zyte's 10 MB limit — Zyte truncates a longer body without an error, so `ScraperService` refuses a proxied body of 10 MB or more rather than parse half a feed. speedbike's feeds are direct (its Árukereső feed is 26 MB); ebikeshop is proxied. A switch writes a `fetch_mode_changed` row on the source's timeline, and `simulate_product_source_import` / `simulate_product_source_scrape` take a `fetchMode` override to check a shop before switching it.
- `frequency` / `nextRunAt` — how often this source runs, and when it is next due. Runs are **started overnight, 02:00–06:00 Europe/Budapest**; `nextRunAt` is always snapped into that window, with jitter so ten shops do not all start at 02:00.
- `detailRefreshInterval` — how old a known listing's detail import may get (an `ms` string, default `'60 days'`, never null) before a run fetches its detail page again, even though its list card could refresh it in place: a card never shows a new GTIN, spec, description or store list. Each listing falls due somewhere in the interval's last quarter, by a hash of its URL, so a whole first import does not fall due on one night. Acts on scraping sources' list cards; a feed row is the whole listing and is re-imported whenever it changes.

**Why read this first:** everything downstream is either producing a `ProductSource` row, reading its `config`, or scheduling work against it.

---

## 2. The config shape — `ProductSourceConfig`

**File:** `libs/database/src/lib/postgres/types/product-source-config.ts`

This is the TypeScript type for the JSONB blob. Its top-level shape:

`ProductSourceConfig` is a **discriminated pair selected by `ProductSource.type`**, not a union inside the document — the type lives on the entity, so repeating it in the config would be a second claim about the same fact.

### Category sections — the same in both shapes

Everything a source knows about one of our categories sits under `categories.<slug>` (`ProductSourceCategoryConfig`):

```ts
categories?: Record<string, {
  enabled: boolean;               // whether listings in this category are imported
  rules?: CategoryMatchRule[];    // which listings are in it: { when, unless? }
  specMapping?: SourceSpecConfig; // how its spec rows map onto the category's schema
  identitySpecRows?: string[];    // the rows the identity extraction reads; omitted = every row
  extraSpecRows?: { label: string; field?: string; pipeline?: ScrapeOperation[] }[]; // feeds only
}>;
```

- **`extraSpecRows` (feed sources) turn feed fields into spec rows**: each entry is resolved like a `mapping` target (a field, then an op pipeline), and a non-empty value is appended as the row `{ name: label, values: [value] }` once the listing's category is known. The gate never sees them. `specMapping`, `identitySpecRows` and spec unification read them like any other row. Examples: the shop's category path (`Webshop kategória`), a bike type named by a sku prefix (`regexCapture` + `mapValue`), one line of a description's component table (`regexCapture`).
- **A `specMapping` entry turns one row into one spec**:
  1. the first of its `labels` present (case-insensitive);
  2. `skipValues`;
  3. then either `valuePatterns` (case-insensitive regexes tried in order; the first match's `value` is the canonical value, and no match gives nothing), or `valueMap` → translation → `trimSuffixes` → `replacePatterns`;
  4. finally the `extract` mode.

  `valuePatterns` read enums and booleans named in free text: `Aluminium Superlite…` → `Alumínium`, a named rack → `Alapfelszereltség`, `nincs` → `Nincs`. `extract: 'multiply'` reads a gear count as chainrings × sprockets (`2X12 SHIMANO` → 24, `1*10` → 10, `24 gears` → 24, `SHIMANO 105` → nothing).
- **Several mappings may share a key; a later one wins only when it yields a value.** Put the general row first (a frame's free text) and the specific one after (a material row), so the specific one decides when present and the general one still fills in when it is missing.

- **A listing is in a category when any of that section's rules matches** (`when` holds and `unless` does not). The rules test:
  - the label the source reads (`detailPage.category.breadcrumbOrSource` or a feed's `category.labelFrom`), with `equalsIgnoreCase`;
  - the listing's raw spec rows, with `specValueIncludes`;
  - on a feed only, the title, with `titleMatches` (a case-insensitive regex). A page reads its title after its category is resolved, so the schema refuses it there.
- **`when` and `unless` also take a list.** A `when` list holds when every condition in it does; an `unless` list blocks the rule when any one does. Example: a frame set or an e-bike filed among a shop's bikes says so only in its title:

  ```jsonc
  "bikes":  { "rules": [{ "when": { "equalsIgnoreCase": "Kerékpárok" }, "unless": [{ "titleMatches": "\\bElektromos\\b" }, { "titleMatches": "vázszett" }] }] },
  "ebikes": { "rules": [{ "when": [{ "equalsIgnoreCase": "Kerékpárok" }, { "titleMatches": "\\bElektromos\\b" }] }] }
  ```
- **A listing that two sections claim is skipped as `category_ambiguous`**, so no rule order between categories decides and adding a category can never silently take another's listings. A disabled section still claims its listings; they are skipped as `category_not_enabled`. On a source that lists its whole catalog, any ambiguous row makes the run incomplete, so the delisting sweep is skipped (`removalSkipped: 'ambiguous_categories'`).
- **A product is one category's.** Every lookup that finds a product for a listing (its history, its siblings, its GTIN and MPN, and name matching) searches the listing's category only, and two products of different categories never merge. A listing the shop files under another category later leaves its old product: its record and the offers only it carried come off it, and it is identified afresh in the new category.
- **The admin UI shows one accordion per section**, each validated against `$defs.categorySection`; MCP `update_product_source_category` saves one section without sending the whole config.
- Configs written before this layout (a shared `slugLookup` list, `specMapping` keyed by slug, source-wide `identityExtraction.specRows`) are converted by `toCategorySections`: the stored ones by the migration `ProductSourceCategorySections1791000000000`, an old version when it is restored.

### `type: 'scraping'`

```ts
interface ScrapingSourceConfig {
  baseUrl: string;
  startUrls: string[];            // replaced fullSyncStartUrl + the old `discovery` block
  categoryLinks?: ScrapeOperation[];  // only when a start URL is a hub page
  categories?: Record<string, ProductSourceCategoryConfig>;  // see "Category sections" above
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
    category: { breadcrumbOrSource: ScrapeOperation[] };  // the label the sections' rules test
    brand: ScrapeOperation[];
    model: ScrapeOperation[];
    aliases?: ScrapeOperation[];
    releaseYear?: ScrapeOperation[];
    images: ScrapeOperation[];
    offers?: { offerList: ScrapeOperation[]; itemMode: 'cheerio' | 'json'; itemPipeline: ScrapeOperation[] /* terminates in assembleOffer */ };
    translation?: { enabled: boolean; sourceLanguage: string; targetLanguage: string; contextTemplate: string };
    // The two LLM calls, switched separately; both on by default.
    // identity: the per-listing identity extraction — the model name, and the
    //   identity and listing-level specs (size, colour) read off the title.
    //   Off, the listing has no model/displayName, only its title
    //   (`originalName`, flagged `identity_off`), and matching uses the title.
    // specs: full spec unification, once per product per source.
    // identityDescription: what of the description the identity extraction
    //   gets — `none` (default), `evidence` (the text around the category's
    //   evidenceKeywords, used only for fields with defined values, so a
    //   description's stray years stay out) or `full`.
    postProcess?: {
      identity?: boolean;
      specs?: boolean;
      identityDescription?: { mode: 'none' | 'evidence' | 'full'; windowWords?: number; maxChars?: number };
      /* model, thinking, effort, maxTokens, includeDescriptionInModelSpecs */
    };
  };
}
```

Everything under `listPage`/`detailPage` is a **pipeline** — an ordered array of operations (`ScrapeOperation[]`) that gets executed against the fetched HTML. That op vocabulary is the next thing to understand.

### `type: 'arukereso'` and `type: 'googleshop'`

Both are feeds with one config shape and one importer (`ArukeresoImportService`); the type only says which feed the shop publishes, so a seller can have one of each. `arukereso` reads an Árukereső XML or CSV/TSV feed; `googleshop` reads a Google Shopping **TSV** feed (a Google RSS/XML feed, with `<item>` and `g:` tags, parses no item). Field names match case-insensitively with `_`, `-` and spaces stripped, so Google's `sale_price` and `image_link` are addressed as written.

```ts
interface ArukeresoSourceConfig {
  baseUrl: string;
  feedUrl: string;                 // fetched over plain HTTP, never through the paid scraper
  format?: 'auto' | 'xml' | 'csv';
  csv?: { delimiter?: 'auto' | ',' | ';' | '\t' };
  categories?: Record<string, ProductSourceCategoryConfig>;  // see "Category sections" above
  category?: { labelFrom?: ScrapeOperation[] };    // turns the raw category value into the label the rules test
  mapping: Record<ArukeresoMappingTarget, FieldMapping | FieldMapping[]>;  // FieldMapping = { field?: string; pipeline?: ScrapeOperation[] }
  postProcess?: ProductSourcePostProcessConfig;    // the same block ({ identity, specs, … }), read by the same service
}
```

Small on purpose: `field` does the addressing and the op pipeline does the transforming, which is why this type needs **no scrape ops of its own**. The mapping targets are a closed set (`ARUKERESO_MAPPING_TARGETS`) asserted by the schema, so a typo'd target is refused rather than silently ignored. A feed is the whole catalogue, so its category sections' rules are what keep everything else out: a feed source with no section imports nothing at all.

**Fallback lists.** A target may map to a list of mappings, tried in order: the first that gives a non-empty value (not undefined, null, `''` or an empty list) wins, and when none does the target is mapped but empty — the source saying "none". Google's price is the case it exists for: `sale_price` when the item is on sale, else `price`. The `coalesce` op cannot do this, as it reads pipeline variables, not feed fields. Google's prices also carry the currency (`2269000 HUF`), which a `stripPattern` removes:

```json
"price": [
  { "field": "sale_price", "pipeline": [{ "op": "stripPattern", "pattern": "\\s*[A-Z]{3}$" }] },
  { "field": "price", "pipeline": [{ "op": "stripPattern", "pattern": "\\s*[A-Z]{3}$" }] }
],
"priceWithoutDiscount": { "field": "price", "pipeline": [{ "op": "stripPattern", "pattern": "\\s*[A-Z]{3}$" }] }
```

**See the real thing:**
- `__fixtures__/ebikeshop.config.json` — scraping, JSON-hydration/Inertia `data-page` markup.
- `__fixtures__/speedbike.config.json` — scraping, classic `<table>` spec extraction. Kept as a style template; speedbike itself is feed-only, so this config has no source row. Before it is revived, check its `detailPage.externalId`: it reads the first `"sku"` in `ShopRenter.product`, and speedbike repeats its `sku` across a product's sizes, while a listing's id must name one page (§8a).
- `__fixtures__/speedbike-arukereso.config.json` — the feed config, reusing that file's 58 spec mappings unchanged, because a feed's `attribute_name` labels are the same labels the shop's own spec table uses.
- `__fixtures__/speedbike-googleshop.config.json` — speedbike's Google Shopping feed: the fallback price, the old price, and both LLM calls off (`postProcess: { identity: false, specs: false }`). Its `id` equals the Árukereső `identifier`, which is how its rows join that source's offers.

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
4. **`ops/*.ts`** — the actual op implementations, grouped by kind: `selection-ops.ts`, `string-ops.ts`, `number-ops.ts` (`round`, for prices with float noise), `regex-ops.ts`, `filter-ops.ts`, `link-ops.ts`, `spec-table-ops.ts`, `image-ops.ts`, `value-map-ops.ts`, `control-ops.ts`.
5. **`services/runtime-data-provider.service.ts`** — the escape hatch for the two things a pipeline can't get purely from the DOM: the list of known brand names (`getBrandNames`, backed by `BrandCacheService`) and category-slug → `ProductCategory` entity lookup (`getCategoryBySlug`, backed by `ProductCategoryRepository`). Referenced in configs via `"source": "runtime:brandCache"` etc. — a small, fixed, reviewable set, not arbitrary DB access.

**Mental model:** `ScrapeInterpreterService` is a pure function of `(task, cheerio-loaded-HTML, config) → structured result`. It never fetches HTML itself and never talks to `TranslationService`/`SpecExtractionService` — those integrations happen one layer up, in step 6.

---

## 5. How a source's config gets exercised, without a network call

**Directory:** `libs/scrape-interpreter/src/lib/interpreter/__fixtures__/`

Before touching the live pipeline, look at the tests here — they're the best way to see the interpreter in action against realistic (hand-written, not live-fetched) HTML:

- `ebikeshop-detail-page.spec.ts` / `speedbike-detail-page.spec.ts` — feed synthetic HTML through `runDetailPage` with the *real* production config, assert the exact `brand`/`model`/`categorySlug`/`rawSpecs`/`imageUrls` output.
- `ebikeshop-list-page.spec.ts` — same idea for list-page parsing.
- `config-validation.spec.ts` — structural check: every `op` name referenced anywhere in both real configs actually exists in the op registry, and each config's category sections resolve sample listings to the expected slugs.

These are the closest thing to living documentation for "what does this config actually produce."

---

## 6. Where fetched HTML enters the interpreter — the two scraper services

**Files:**
- `libs/product-scraper/src/lib/product-scraper/services/product-list-page-scraper.service.ts`
- `libs/product-scraper/src/lib/product-scraper/services/product-details-page-scraper.service.ts`

These are the two services that actually get invoked per `ProductImportTask`. Both:
1. Fetch HTML via `ScraperService.getHtml(task.url, task.source.fetchMode)` — through the Zyte API (`libs/zyte`) when the source is `proxied`, from the shop itself (`NativeScraperService`) when it is `direct`.
2. `cheerio.load()` it.
3. Call the interpreter (`runListPage` or `runDetailPage`) with `task.source.config`.
4. Do something with the result.

`ProductListPageScraperService` turns the interpreter's `{categoryName, categoryLinks, productLinks}` into new `ProductImportTask` rows (pagination → more list tasks, product links → detail tasks), deduping via `ScrapeUrlDeduplicationService`.

`ProductDetailsPageScraperService` is the more involved one — it's also where the interpreter's raw output gets turned into a finished `ScrapedProduct`:
1. Calls `interpreter.runDetailPage(...)`.
2. Checks that exactly one category section's rules matched (two is `category_ambiguous`), and that the section is `enabled`.
3. Resolves the category slug to a real `ProductCategory` entity via `RuntimeDataProviderService`.
4. Loads the category's JSON schema (`CategoryConfigService.getJsonSchema` — **this one thing stayed file-based**, see step 9).
5. **Translation**: reads `config.detailPage.translation`, and if enabled, calls `SpecTranslationSelectorService.collectTranslatableValues()` (which values are worth translating — skips numeric-mode specs and values already resolved by a `valueMap`) then `TranslationService.translateBatch()` (LLM-backed, cached). The interpreter itself never touches translation — this is a deliberate layering decision (DOM-parsing should stay pure; translation is a metered external call).
6. Calls `SpecExtractionService.extractSpecs()` — the **unchanged** engine that turns raw label/value pairs into canonical `ProductSpecs`, using the category section's `specMapping` (the same `SourceSpecMapping[]`/`extract` mode/`valueMap` system as before — see step 9).
7. Assembles the final `ScrapedProduct` and hands it to `ProductScrapeUpdaterService` (step 8).

---

## 7. What replaced the per-source dispatch switches

**Files:**
- `apps/product-collector/src/modules/queue-processor/product-import-task/product-import-task-processor.service.ts` — replaces the old per-source queue processor classes. Routes purely by `task.queue` (list vs. detail), no source branching at all.
- `libs/product-scraper/src/lib/product-scraper/services/scraping-import.service.ts` — the `scraping` importer. Replaced `GenericProductSourceSyncService`, whose whole job was running a `config.discovery` block to *find* start URLs; neither live config ever had one, so a "full sync" silently did nothing. `startUrls` names them outright.
- `libs/product-scraper/src/lib/arukereso/arukereso-import.service.ts` — the feed importer, registered for both `arukereso` and `googleshop` and resolved through `ProductSourceImporterRegistry` by `source.type`.

**Category expansion and pagination are resolved once per run, by the importer — never by a list page.** That is not a style preference: `generatePaginationLinks` had no page-1 guard and task creation did not dedupe, so a self-paginating listing re-emitted its whole page range from every page it landed on. Both live configs had to leave `categoryLinks` empty to work around it. A list-page task is now a pure "parse the items here" unit with no power to enqueue more pages, which makes that whole class of bug structurally impossible rather than guarded against.

The task processor reads `source.config` and does not know which source it is looking at; the importers are selected by `source.type` and nothing else.

---

## 8. Persistence — where a `ScrapedProduct` becomes database rows

**File:** `libs/product-scraper/src/lib/product-scraper/services/product-scrape-updater.service.ts`

This service was already the persistence core before this change and is mostly unchanged in shape — the main addition is Offer/Seller handling. Flow:

1. `resolveProductIdentity` — is this a known product (a stored id: the task, an offer externalId, a source externalId) or does it need listing matching (`libs/product-identity`, Path 4: name score, spec gates, and the LLM only for the near-misses)?
2. `persistProduct` — create or update the `ProductModel`, write the per-source `ProductModelSource` row (now via `source: ProductSource` FK instead of a `type` enum — see step 10), re-merge specs across all sources by `ProductSource.priority`.
3. `applyPostSaveSideEffects` — slug generation, alias insertion, image copying to Bunny CDN, and (new) **`createOrUpdateOffers`**.

**`createOrUpdateOffers`**: if `scrapedProduct.offers` is populated, the listing's record keeps them (each entry stamped with its `resolvedExternalId`), and `OfferComposerService.compose` then computes each `Offer` (keyed on `[seller, externalId]`) from **all** of the seller's current records, field by field by source priority — see §11. It always bumps `lastSynced`/`active`. One bad offer doesn't fail the whole scrape — logged and skipped.

Two things here are load-bearing and easy to miss, because **the `(seller, externalId)` unique constraint does not error on a collision — it keeps the last writer**:

- **`externalId` is resolved for the whole page at once.** A source-native id when there is one, otherwise the URL slug (derived in shared code, so a scraping source and a feed source for one shop land on the same string — that is how they converge on one offer). Any value claimed by more than one offer on the page is dropped for all of them: otherwise three size variants at one URL would collapse into ONE offer row, with nothing logged.
- **The conflict branch is cross-source adoption, not rare concurrency.** Offers are preloaded per *source*, so a second source importing a listing the first already owns cannot see that row, conflicts on insert, and adopts it. If the two sources resolved *different* products for the listing, it throws `OfferIdentityConflictError` rather than rebinding (which would silently move a listing) or leaving it (which would silently strand the other model with no offer, hence no price).

Both feed `offer_identity_conflict_total{source,kind}`.

Both `ebikeshop.config.json` and `speedbike.config.json` populate `detailPage.offers` today, so this runs on every scrape for those sources — a single-seller storefront config populates `offers.listItems`/`price` (and, for ebikeshop, `priceWithoutDiscount`) directly from its own listing/price markup. Seller is never scraped per offer — every offer belongs to its `ProductSource.seller`.

### 8a. The listing's id: the key of its record

A listing is one detail page, or one feed row. Its `ProductSourceRecord` is found and written by `(source, externalId)`, where the id is `listingExternalIdOf` (`libs/utils`): the listing's source-native id (`detailPage.externalId`, or a feed's `mapping.externalId`), trimmed, else the slug of its URL. Every import, feed triage, list card and identity lookup (Path 3) uses it, so a URL the shop renamed finds the same record, which moves to the new URL (`ProductSourceRecordUpdaterService.moveUrl`, logged as `Listing URL changed`, counted in `source_record_url_changed_total{source}`). A source without ids is keyed by its URL slug, so a rename there still leaves the old record behind.

The id must **name exactly one listing** within its source:

- A size group's shared id (ShopRenter's `parent.sku`, say) is not a listing id. It belongs in `siblingIds`.
- A feed whose id repeats across rows at different URLs is refused, not renamed: a run imports the first row of each id, skips the rest and reports them as `duplicateExternalIds`. `simulate_product_source_import` lists repeated ids as an error.
- The same listing moving back and forth between two URLs in `source_record_url_changed_total` means a config emitting one id for two pages.

**A page listing several sizes at one URL** is one listing, keyed by its own page id; each size is an offer with its own id. When the page shows no per-size id, compute one in the offer pipeline with the `literal` op, which fills in `{{vars}}`: `{{externalId}}-{{size}}`, or `{{externalId}}-{{color}}-{{size}}`. The rules:

- read the size from the page (its size selector), never from the AI;
- normalize the size token, so `M`, `m` and ` M ` give one id;
- include every variant axis that differs between the page's offers;
- prefer a real per-size sku when the page has one;
- when the seller also has a feed, match the feed's id format (speedbike's is `1104300-XL`), so both sources compose the same offers.

For example, page `1260042` with sizes S, M and L: one record under `1260042`, and offers `1260042-S`, `1260042-M`, `1260042-L`.

---

## 9. What stayed exactly as it was

Not everything moved into the JSONB config. Two things were deliberately left alone:

- **`SpecExtractionService`** (`libs/product/src/lib/services/product-spec/spec-extraction.service.ts`) — the engine that interprets `SourceSpecMapping[]`/`CalculatedSpecRule[]` (label→key mapping, the 12 `extract` modes like `number`/`cmToInchList`/`regexpList`, calculated specs like `presentIfKey`/`featureSearch`). This was already pure declarative JSON consumption before this change; only *where the mapping JSON lives* changed (moved from `libs/config/src/lib/categories/<slug>/specMappings.json` into each `ProductSource`'s `config.categories.<slug>.specMapping`).
- **`CategoryConfigService`** (`libs/config/src/lib/services/category-config.service.ts`) — still file-based, still loads `libs/config/src/lib/categories/<slug>/{config.json,jsonSchema.json,uiSchema.json}` from disk. This is genuinely per-**category** (the canonical spec schema, shared across every source), not per-source parsing config, so it didn't belong in `ProductSource.config`. Its `getSpecMappings*`/`writeSpecMappings` methods *were* removed (that content moved to per-source config) — everything else is untouched.

---

## 10. `ProductSourceType`, twice — and they are not the same thing

**Read this if §1's `type` field surprised you.** There have been two different things called `ProductSourceType`, and conflating them will send you in the wrong direction.

The **old** one was a 3-value enum (`arukereso | displaySpecs | manual`) used as an identity/grouping key — "which kind of thing produced this data". It is gone, and the rest of this section is about that removal.

The **current** one is `'scraping' | 'arukereso' | 'googleshop'` and answers a different question: **which importer runs this source, and therefore which shape its config takes**. It is not a grouping key and nothing switches on it for identity — the importer registry resolves it once (`ProductSourceImporterRegistry`), the config validator dispatches the right JSON Schema off it, and that is all. It is fixed at creation because the stored config would otherwise be reinterpreted under a format that shares none of its keys.

That the old name came back for a new meaning is unfortunate. The distinguishing test: the old type grouped *rows by origin*, the new type selects *code by config format*.

---

Wherever code used to switch or group on the OLD `.type`, it now uses either:
- the actual `ProductSource` row (via a new FK — `ProductModelSource.source`, `Offer.source`), or
- `ProductSource.name` as a plain string (for Prometheus metric labels — cardinality stays bounded because sources are added deliberately, not per-request).

The one exception worth knowing about: **admin-entered specs** (via the product-edit UI) have no `ProductSource` at all — `ProductModelSource.source` is `null` for those rows, which is now the signal that used to be `type === 'manual'`. See `ProductUpdateMapperService.mapManualSpecs` (`libs/product/src/lib/services/update/product-update-mapper.service.ts`).

---

## 11. Several sources per seller

A shop may have several sources: speedbike has its Árukereső feed and its Google Shopping feed. Each source keeps its own records, and the offers, the specs and the description are computed from all of them, so the sources never overwrite each other's data and the order they run in does not matter.

- **`identifiesProducts`** (default on; a seller keeps at least one). An identifying source runs identity resolution and creates products and offers. A contributing source (off) runs none of it:
  - its row joins the seller's offer with the same `externalId`, the shared fallback of `resolveOfferExternalIds`, so the id must match across the seller's sources;
  - with no such offer yet, it is stored as an **unattached** record (`model` null). The identifying source's write of that offer attaches it at once (`attachWaitingRecords` in `writeListing`). Both sides take the offer-key advisory lock (`offerKeyLock`), so neither can miss the other;
  - when the offer is removed (the stale sweep, or a complete source), its contributing records are detached again (`ContributorDetachService`): "unattached" always means "the seller has no offer for it".
- **`priority`**, unique per seller, decides **field by field**: `OfferComposerService.compose` takes price, old price, currency, availability, condition, url, GTIN, MPN, locations and offer specs from the highest-priority current record (seen within the freshness window) that speaks for the field. Condition falls back to `new` when no record speaks for it, or the one that does says "none".
  - A source speaks only for the fields its config maps. A mapped field with no value is stored as `null`, meaning "none", and counts. An unmapped field is absent, and stays silent. That is how Google's old price fills in for an Árukereső feed that has none, and how an ended sale clears it.
  - An old price is kept only above the resulting price, and the offer's `sourceRecord` is the record that supplied the price.
- **Specs** vote once per seller (`groupRecordsBySeller`): within a seller, priority decides key by key; across sellers, agreement. **Names** come only from identifying sources.
- **The description** (`ProductDescriptionService.pick`): the admin's record wins; otherwise the highest-priority source whose text is at least 40 characters as plain text (`htmlToText` drops shop HTML, Word markup and scripts); ties go to the longer text, then the lower source id, then the lower URL. The public site gets plain text with line breaks.
- **`hasAllProducts`**: a feed source that lists the whole catalog. At the end of a complete run (no `maxItems` cap reached, no `filter`, every enabled category, no row that failed to map), the seller's offers in those categories that the run did not see are removed, even while another source still lists them. It removes nothing when that would be more than 10% of them (`MAX_COMPLETE_RUN_REMOVAL_SHARE`), or when `offers.completeSourceRemovalEnabled` is off. The run summary's `removalSkipped` says why a run removed nothing. Scraping sources cannot set it: a crawl has no single end.
- **Seeing it:**
  - `list_product_source_records` (`attached: false` for the waiting ones);
  - the unattached count in `get_product_source_import_status`, and the Listings box on the admin source page;
  - `simulate_product_source_import`, which for a contributing source counts the rows matching an existing offer, and for any feed the rows carrying an old price.
- **A contributing source's names:** it never names a product, and its record stores no match key (`normalizedSourceName` null), since nothing matches on it. With `postProcess.identity` on, its listings still get the identity extraction: that names the record and reads its listing-level specs (size, colour), which fill the offer's keys the seller's higher sources lack. With it off, a record has only its title (`originalName`), flagged `identity_off`.
- **Speedbike's setup:** `speedbike-arukereso` (priority 60, identifying, complete) and `speedbike-googleshop` (priority 40, contributing, `postProcess: { identity: false, specs: false }`, so its rows make no LLM call). Google brings the old price and real descriptions where the Árukereső feed carries only an article number. Its titles are the same as Árukereső's and it has no spec table, so an extraction there would add nothing but the colour a few descriptions state (Giant/Liv), which also needs `postProcess.identityDescription` in `full` mode.
- **Checked by** `apps/product-collector/scripts/verify-multi-source.ts` on `fittkereso_e2e`: A then G, G then A and both at once end in the same state, plus the removal and admin-description scenarios.

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
      list_page task per page. Then returns; the poller does the rest.

  ── types 'arukereso' and 'googleshop' ───────────────────────────
  ArukeresoImportService
    → one GET in the source's fetchMode (speedbike's are direct),
      streamed through ArukeresoFeedParserService, every row
      mapped (deterministic, no LLM) and triaged against its listing's stored
      feedRowHash (ArukeresoFeedTriageService): an unchanged row only has its
      offer's lastSynced confirmed; a new or changed row becomes a feed_entry
      task carrying the row. Then returns; the run takes seconds.

ProductImportTaskManagerService (every tick, 30s by default)
  → claims up to importTaskBatchSize tasks (priority first, then random within
    a priority; one page task per source per tick, within its maxConcurrent
    and requestsPerHour) and runs each, routed by task.kind:
      list_page            → ProductListPageScraperService.scrapeListPage(task)
                                → interpreter.runListPage → ScrapedListProduct[]
                                → per card, ListProductRefreshService decides:
                                    refresh the offer in place (no detail fetch
                                    spent), or enqueue a detail_page task —
                                    for an unknown listing, a card missing a
                                    required field, or a listing past its
                                    detailRefreshInterval (`stale`). A card is
                                    matched to its record by (source,
                                    externalId) first, then by URL; a listing
                                    found under another URL moves to the
                                    card's (an unattached one when its
                                    detail page is imported).
                                → detail tasks go through DetailTaskCapService:
                                  with maxItems set, the run queues no more once
                                  it has queued that many, counted across all its
                                  list pages (each carries the run's start)
                                → enqueues NO further list pages, by design
      detail_page          → ProductDetailsPageScraperService
                                → interpreter.runDetailPage; a task queued
                                  from a list card carries the card's
                                  externalId, and a page stating other ids
                                  (a redirect to another product) fails the
                                  task terminally, unimported
                                → spec extraction,
                                  SpecPostProcessService (hash-skipped when
                                  nothing changed)
                                → ScrapedProduct
      feed_entry           → ArukeresoFeedEntryService (not rate-gated)
                                → the stored row mapped again with the
                                  source's current config → ScrapedProduct,
                                  plus its feedRowHash for the listing

  ── both types converge here ─────────────────────────────────────
  ProductScrapeUpdaterService.createOrUpdateProduct(context, scrapedProduct)
    → resolve/create ProductModel, write ProductSourceRecord, merge specs
    → slug, aliases, images
    → createOrUpdateOffers (externalId resolved per page, offers stamped
      with lastSynced)
```

Everything below the converge line is import-agnostic: identity resolution, merge, spec validation and offer upsert cannot tell whether a product arrived as HTML or as a feed row. That is what `ProductImportContext` is for — the persistence path used to take a `ProductImportTask`, and a feed run has none.

---

## If you want to add a new source

**Use the `add-webshop` skill** (`.claude/skills/add-webshop/`) — it is the maintained procedure, with a plan/execute split and a human review gate between them. In outline:

0. **Decide the type first.** Probe for a feed before assuming you must scrape: `curl -o /dev/null -w '%{http_code}' 'https://<shop>/api/?route=export/feed&id=arukereso'` (ShopRenter's pattern — 200 enabled, 405 disabled, 401 password-protected; `id=google_shopping` is the same shop's Google Shopping TSV, a `googleshop` source). One GET beats thousands of paid page fetches. The type cannot be changed afterwards.
1. Author the config for that type, against the schema `get_product_source_config_schema({ type })` returns. Copy the closest fixture: `ebikeshop.config.json` (JSON-hydration markup), `speedbike.config.json` (classic `<table>`), `speedbike-arukereso.config.json` (feed), `speedbike-googleshop.config.json` (a Google Shopping feed contributing to another source's offers). A shop that publishes both feeds gets both sources: the Árukereső one identifying, the Google one contributing at a lower priority (§11).
2. Write golden-fixture tests under `libs/scrape-interpreter/src/lib/interpreter/__fixtures__/`, and add the config to `config-validation.spec.ts` — that spec is the pre-deploy gate.
3. Only if the source needs a DOM pattern the current 53 ops cannot express, add one: type in `scrape-operation.ts`, handler in `ops/*.ts`, registration in `ops/register-ops.ts`, name in `SCRAPE_OPERATION_NAMES` (a spec asserts those two agree in both directions).
4. Create the `ProductSource` row with its `type` (see `seed-product-source-configs.ts`), scheduling off.
5. Dry-run it: `simulate_product_source_import({ productSourceId })` reports what a run would do without writing anything — for a feed, how much survives the category gate and whether the chosen `externalId` is unique across it; for a scraping source, the page walk and the per-card refresh-vs-detail-fetch split. Enable scheduling only once that looks right.
6. No other code changes needed — scheduler, task managers, importers and persistence all work off `source.type`/`source.config`.
