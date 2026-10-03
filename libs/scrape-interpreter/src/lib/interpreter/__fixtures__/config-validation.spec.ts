import {
  ArukeresoMappingTarget,
  ArukeresoSourceConfig,
  ProductSourceConfig,
  ProductSourceType,
  ScrapedProductSpec,
  ScrapingSourceConfig,
  ProductSourceConfigValidatorService,
  SourceSpecMapping,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import {
  ProductSpecNormalizationService,
  SpecExtractionService,
} from '@fittkereso-backend/product';
import { normalizeYear } from '@fittkereso-backend/utils';
import { castArray, isArray, isEmpty, isNil, isString, pick } from 'lodash';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { registerOps } from '../ops/register-ops';
import akosbikeArukeresoConfig from './akosbike-arukereso.config.json';
import ambringaArukeresoConfig from './ambringa-arukereso.config.json';
import bikelifeArukeresoConfig from './bikelife-arukereso.config.json';
import bringaboardArukeresoConfig from './bringaboard-arukereso.config.json';
import ebikeshopConfig from './ebikeshop.config.json';
import mangobikeArukeresoConfig from './mangobike-arukereso.config.json';
import speedbikeConfig from './speedbike.config.json';
import speedbikeArukeresoConfig from './speedbike-arukereso.config.json';
import speedbikeGoogleshopConfig from './speedbike-googleshop.config.json';
// The size specs are read against the category's real, current schema, as
// speedbike-detail-page.spec.ts does, for the same reason.
// eslint-disable-next-line @nx/enforce-module-boundaries
import ebikesJsonSchema from '../../../../../config/src/lib/categories/ebikes/jsonSchema.json';

const SIZE_KEYS = ['frameSize', 'frameSizeLabel'];

/** What a mapping fallback list moves past: no value at all. */
function isBlank(value: unknown): boolean {
  return isNil(value) || (isString(value) && !value.trim()) || (isArray(value) && isEmpty(value));
}

function asText(value: unknown): string | undefined {
  return isNil(value) ? undefined : String(value).trim() || undefined;
}

const asFeedConfig = (json: unknown) => json as ArukeresoSourceConfig;

/** Presence in the feed means in stock; Árukereső's documented "NO" overrides it. */
const IN_STOCK_UNLESS_NO = [
  { op: 'mapValue', cases: { NO: 'out_of_stock' }, default: 'in_stock' },
];

// Schema validation of the hand-authored production configs — not a live-site
// test, but it catches typos in op names, missing or misspelled op
// parameters, unknown keys, bad enum values and structurally invalid JSON
// before these configs are seeded as ProductSource.config rows.
//
// This used to walk the config collecting `op` strings and probe the runtime
// registry with each one, which checked only that every op NAME existed. The
// schema checks the parameters too, so the hand-rolled walk is gone; what
// keeps the schema's op list honest is scrape-operation-schema.spec.ts, which
// compares it against that same registry directly.
describe('hand-authored source configs', () => {
  let validator: ProductSourceConfigValidatorService;
  let interpreter: ScrapeInterpreterService;

  beforeAll(() => {
    validator = new ProductSourceConfigValidatorService();

    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());
    // No value pipeline in a feed config reads the runtime.
    interpreter = new ScrapeInterpreterService(runner, {} as never);
  });

  function assertConfigValid(
    config: ProductSourceConfig,
    label: string,
    type: ProductSourceType = 'scraping',
  ) {
    const problems = validator.problems(type, config);

    // Rendered into the failure message rather than asserted as `toBeNull()`:
    // a bare "expected null, got [object Object]" would make somebody re-run
    // this by hand to find out which path was wrong.
    expect(problems ? `${label}: ${validator.format(problems)}` : null).toBeNull();
  }

  // A feed row's mapping target and category, read the way
  // ArukeresoProductMapperService.resolveTarget and resolveCategory read them,
  // through the real interpreter. That service lives in product-scraper, which
  // depends on this library, so this spec can't import it. Fields are keyed
  // here exactly as the config names them, so the importer's spelling-tolerant
  // field lookup isn't needed.
  //
  // A target mapped to a list takes the first non-empty value, which is what
  // the bikelife and mangobike gates are built on. The result is trimmed text,
  // and an empty one is no value, as the importer reads every target here.
  async function readText(
    config: ArukeresoSourceConfig,
    target: ArukeresoMappingTarget,
    fields: Record<string, string>,
  ): Promise<string | undefined> {
    let value: unknown;
    for (const mapping of castArray(config.mapping[target] ?? [])) {
      const raw = mapping.field ? fields[mapping.field] : undefined;
      value = isEmpty(mapping.pipeline)
        ? raw
        : await interpreter.runValuePipeline(mapping.pipeline ?? [], raw, {
            baseUrl: config.baseUrl,
          });
      if (!isBlank(value)) break;
    }
    return asText(value);
  }

  async function slugOf(
    config: ArukeresoSourceConfig,
    fields: Record<string, string>,
    attributes: ScrapedProductSpec[] = [],
  ): Promise<string | undefined> {
    const rawLabel = await readText(config, 'categoryLabel', fields);
    const label = isEmpty(config.category.labelFrom)
      ? rawLabel
      : asText(
          await interpreter.runValuePipeline(config.category.labelFrom ?? [], rawLabel, {
            baseUrl: config.baseUrl,
          }),
        );

    return interpreter.resolveCategoryFromRules(config.category.slugLookup, label, attributes);
  }

  it('validates the ebikeshop config against the config schema', () => {
    assertConfigValid(ebikeshopConfig as unknown as ScrapingSourceConfig, 'ebikeshop');
  });

  it('validates the speedbike config against the config schema', () => {
    assertConfigValid(speedbikeConfig as unknown as ScrapingSourceConfig, 'speedbike');
  });

  // By the category the product page states, not "always": ebikeshop answers
  // an unknown product URL with a redirect to some other product (a cable,
  // say), which must not be filed as an e-bike.
  it('ebikeshop config files only the e-bike category as ebikes', () => {
    const config = ebikeshopConfig as unknown as ScrapingSourceConfig;
    expect(config.detailPage.category).toEqual({
      breadcrumbOrSource: [
        {
          op: 'parseJsonAttr',
          selector: '#app',
          attr: 'data-page',
          path: 'props.product.category.slug',
        },
      ],
      slugLookup: [{ when: { equalsIgnoreCase: 'elektromos-kerekparok' }, slug: 'ebikes' }],
    });
  });

  // ebikeshop's listing paginates on `oldal` (Hungarian for "page") — the
  // param its own pagination links use. It silently ignores `?page=N` and
  // serves page 1 again, so a wrong template doesn't fail: it re-imports the
  // first 32 bikes once per page and never reaches the other 576.
  //
  // Sorted by name: under the default price sort a price change between two
  // list tasks moves a bike to another page, where one run misses it or sees
  // it twice. The template appends with `&`, so every start URL must already
  // carry a query string.
  it('ebikeshop config paginates on the query param the site actually reads, sorted by name', () => {
    const config = ebikeshopConfig as unknown as ScrapingSourceConfig;
    expect(config.listPage.pagination?.urlTemplate).toBe(
      '{{startUrl}}&oldal={{page}}',
    );
    expect(config.startUrls).toEqual([
      'https://ebikeshop.hu/termekek/elektromos-kerekparok?rendezes=nev_szerint_novekvo',
    ]);
    for (const startUrl of config.startUrls ?? []) {
      expect(new URL(startUrl).search).not.toBe('');
    }
  });

  // productCode is KTM's own article number (1260040108), which is what makes
  // it an MPN that other shops' KTM listings can match. The offer's externalId
  // is the same value, so offers keep converging on it as before.
  it('ebikeshop config reads GTIN and MPN off the product payload', () => {
    const offer = (ebikeshopConfig as unknown as ScrapingSourceConfig).detailPage
      .offers?.itemPipeline[0] as { gtin?: unknown; mpn?: unknown; externalId?: unknown };
    const readsPath = (path: string) => [
      { op: 'parseJsonAttr', selector: '#app', attr: 'data-page', path },
    ];

    expect(offer.gtin).toEqual(readsPath('props.product.gtin'));
    expect(offer.mpn).toEqual(readsPath('props.product.productCode'));
    expect(offer.externalId).toEqual(readsPath('props.product.productCode'));
  });

  // The shop's own size grouping, and the only sibling signal trusted: all 752
  // sibling pairs in the 2026-09-23 crawl listed the identical set.
  it('ebikeshop config takes sibling ids from the frame-size variations', () => {
    expect(
      (ebikeshopConfig as unknown as ScrapingSourceConfig).detailPage.siblingIds,
    ).toEqual([
      {
        op: 'parseJsonAttr',
        selector: '#app',
        attr: 'data-page',
        path: 'props.product.variations',
      },
      { op: 'filterJsonArray', path: 'type', equals: 'frame_size' },
      { op: 'flattenJsonArray', path: 'items' },
      {
        op: 'mapJsonArray',
        fields: { productCode: { path: 'productCode' } },
        flattenField: 'productCode',
      },
    ]);
  });

  // Its 23-row property table is short enough to send whole.
  it('ebikeshop config sends its whole spec table to the identity extraction', () => {
    expect(
      (ebikeshopConfig as unknown as ScrapingSourceConfig).identityExtraction,
    ).toBeUndefined();
  });

  it('speedbike config resolves E-BIKE breadcrumb text to the ebikes category', () => {
    const config = speedbikeConfig as unknown as ScrapingSourceConfig;
    expect(config.detailPage.category.slugLookup).toEqual([
      { when: { equalsIgnoreCase: 'E-BIKE' }, slug: 'ebikes' },
    ]);
  });

  it('speedbike config enables both LLM calls', () => {
    const config = speedbikeConfig as unknown as ScrapingSourceConfig;
    expect(config.detailPage.postProcess).toEqual({ identity: true, specs: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EVERY LIVE CONFIG IS CURRENTLY CAPPED FOR TESTING.
  //
  // This test exists to make that impossible to forget. It is not describing a
  // property worth preserving — it is a tripwire. Before any real catalogue
  // run, remove `maxItems` from these configs and delete this test with it;
  // otherwise a source that looks fully configured will import a handful of
  // products and stop, and nothing else will say why.
  //
  // ebikeshop is capped at 100 detail tasks per run (user, 2026-09-26): every
  // list page is still walked and every known card refreshed in place; a run
  // stops queueing detail pages once it has queued 100.
  // ─────────────────────────────────────────────────────────────────────────
  it.each([
    ['ebikeshop', ebikeshopConfig, 100],
    ['speedbike', speedbikeConfig, 10],
    ['speedbike-arukereso', speedbikeArukeresoConfig, 10],
    ['speedbike-googleshop', speedbikeGoogleshopConfig, 10],
  ])('%s is capped — REMOVE BEFORE A REAL RUN', (_name, config, cap) => {
    expect((config as { maxItems?: number }).maxItems).toBe(cap);
  });

  it('ebikeshop config has no postProcess override, so it picks up the on-by-default behavior', () => {
    expect(
      (ebikeshopConfig as unknown as ScrapingSourceConfig).detailPage.postProcess,
    ).toBeUndefined();
  });

  describe("speedbike's Árukereső feed config", () => {
    const config = speedbikeArukeresoConfig as unknown as ArukeresoSourceConfig;

    it('validates against the Árukereső config schema', () => {
      assertConfigValid(config, 'speedbike-arukereso', 'arukereso');
    });

    // sku is SHARED across size variants in this feed — 804200 is both the L
    // and the XL CUBE AMS Hybrid — and Offer is @Unique([seller, externalId]),
    // so mapping sku here would collapse every size of a bike onto one row and
    // silently keep only the last one imported. `identifier` is filled on all
    // 3488 products and unique per variant.
    it('keys identity on identifier rather than the variant-shared sku', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'identifier' });
    });

    // 75% of the feed's e-bike rows carry a checksum-valid ean_code. GIANT and
    // LIV put 7-digit article stubs there instead, which normalizeGtin drops.
    it('reads the GTIN from ean_code', () => {
      expect(config.mapping['gtin']).toEqual({ field: 'ean_code' });
    });

    // The sku is the manufacturer's article number, sometimes with an "MX"
    // prefix on KTM rows (60 of 737) that no other shop uses.
    it('reads the MPN from sku, without the shop\'s MX prefix', () => {
      expect(config.mapping['mpn']).toEqual({
        field: 'sku',
        pipeline: [{ op: 'stripPattern', pattern: '^MX' }],
      });
    });

    // Measured on the 2026-09-23 feed: with this list every e-bike row still
    // sends at least one row per identity group — frame 100%, battery 99%,
    // motor 96%, wheels 100%, drivetrain 100%, weight 88% — while sending
    // about 11 of its ~32 rows. Dropping one of these groups would silently
    // cost the extraction the specs it carries.
    it.each([
      ['frame', ['Váz', 'Frame']],
      ['motor', ['Motor', 'E-System']],
      ['battery', ['Akkumulátor', 'Battery']],
      ['wheels', ['Kerék', 'Első kerék', 'Gumi', 'Első gumi']],
      ['drivetrain', ['Hátsó váltó', 'Fogaskoszorú', 'Gear Shift']],
      ['weight', ['Súly', 'Weight']],
    ])('sends the %s rows to the identity extraction', (_group, labels) => {
      expect(config.identityExtraction?.specRows).toEqual(
        expect.arrayContaining(labels),
      );
    });

    // The feed's attribute_name values are the same labels the shop's own spec
    // table uses, which is what makes a feed source cheap to add for a shop
    // that was already scraped. The size is the one addition: a page shows it
    // in its size selector rather than its spec table, while the feed carries
    // it as a `Méret` (or `size`) attribute on about half of its e-bike rows.
    it('reuses the scraping source spec mappings, plus the frame size', () => {
      const scraping = (speedbikeConfig as unknown as ScrapingSourceConfig)
        .detailPage.specMapping['ebikes'];
      const feed = config.specMapping?.['ebikes'];
      const isSize = (mapping: SourceSpecMapping) => SIZE_KEYS.includes(mapping.key);

      expect({ ...feed, mappings: feed?.mappings.filter((m) => !isSize(m)) }).toEqual(
        scraping,
      );
      expect(feed?.mappings.filter(isSize).map((m) => m.key)).toEqual(SIZE_KEYS);
    });

    // The distinct shapes of the 2026-09-24 feed's size values: centimetres
    // are the frame size, a trailing letter the label, and a kids' bike's
    // "ONE SIZE" wheel sizes are neither — read as a number, 24" would pass
    // for a 24 cm frame.
    it.each([
      ['Méret', 'M', { frameSizeLabel: 'M' }],
      ['Méret', 'XXL', { frameSizeLabel: 'XXL' }],
      ['Méret', 'Easy Entry L', { frameSizeLabel: 'L' }],
      ['Méret', 'Trapeze XL', { frameSizeLabel: 'XL' }],
      ['Méret', '54 cm', { frameSize: 54 }],
      ['Méret', 'Easy Entry 46 cm', { frameSize: 46 }],
      ['Méret', 'Trapeze 50 cm', { frameSize: 50 }],
      ['size', '62 cm', { frameSize: 62 }],
      ['Méret', '24" / 20": ONE SIZE', {}],
      ['Méret', '26": ONE SIZE', {}],
    ])('reads the %s attribute %j', (name, value, expected) => {
      const ebikes = config.specMapping?.['ebikes'];
      if (!ebikes) throw new Error('The fixture has no ebikes specMapping');
      const specs = new SpecExtractionService(
        new ProductSpecNormalizationService(),
      ).extractSpecs({
        scrapedSpecs: [{ name, values: [value] }],
        schema: ebikesJsonSchema as unknown as SpecDefinitionJsonSchema,
        sourceConfig: ebikes,
      });

      expect(pick(specs, SIZE_KEYS)).toEqual(expected);
    });

    it('resolves the breadcrumb path to the same category rule the scraper uses', () => {
      expect(config.category.slugLookup).toEqual(
        (speedbikeConfig as unknown as ScrapingSourceConfig).detailPage.category
          .slugLookup,
      );
    });

    // Being in the feed is the stock signal: a shop generates its feed from
    // what it is currently offering. `delivery_time` is empty on all 3486 of
    // speedbike's products, and mapValue returns its `default` for a non-string
    // input — so every offer reads in_stock unless Árukereső's documented "NO"
    // marker appears, at which point the feed overrides the default.
    it('reads presence in the feed as in stock, and lets "NO" override it', () => {
      expect(config.mapping['availability']).toEqual({
        field: 'delivery_time',
        pipeline: IN_STOCK_UNLESS_NO,
      });
    });
  });

  // Speedbike's Google Shopping feed: only a contributor to the Árukereső
  // source's offers, for the old price and the descriptions that feed lacks.
  describe("speedbike's Google Shopping feed config", () => {
    const config = speedbikeGoogleshopConfig as unknown as ArukeresoSourceConfig;
    const arukereso = speedbikeArukeresoConfig as unknown as ArukeresoSourceConfig;
    const stripCurrency = [{ op: 'stripPattern', pattern: '\\s*[A-Z]{3}$' }];

    it('validates against the feed config schema', () => {
      assertConfigValid(config, 'speedbike-googleshop', 'googleshop');
    });

    // Its `id` equals the Árukereső `identifier` on every row, which is what
    // joins its rows to that source's offers.
    it('keys offers on id, the Árukereső identifier', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'id' });
    });

    // Google's price is the list price; sale_price, when there is one, is
    // what the shop charges. "2269000 HUF" is no number without the strip.
    it('takes the sale price, else the price, and the price as the old price', () => {
      expect(config.mapping['price']).toEqual([
        { field: 'sale_price', pipeline: stripCurrency },
        { field: 'price', pipeline: stripCurrency },
      ]);
      expect(config.mapping['priceWithoutDiscount']).toEqual({ field: 'price', pipeline: stripCurrency });
    });

    it('resolves categories as the Árukereső source does', () => {
      expect(config.category).toEqual(arukereso.category);
      expect(config.categories).toEqual(arukereso.categories);
    });

    // It identifies nothing and carries no specs: no LLM call has anything to do.
    it('turns both LLM calls off', () => {
      expect(config.postProcess).toEqual({ identity: false, specs: false });
    });
  });

  // Wave 1 of the e-bike shop onboarding (docs/webshops/plans/, 2026-10-02):
  // five shops, each with one identifying Árukereső-format feed.
  describe.each([
    ['ambringa-arukereso', ambringaArukeresoConfig],
    ['akosbike-arukereso', akosbikeArukeresoConfig],
    ['bikelife-arukereso', bikelifeArukeresoConfig],
    ['mangobike-arukereso', mangobikeArukeresoConfig],
    ['bringaboard-arukereso', bringaboardArukeresoConfig],
  ])('wave-1 feed config %s', (name, json) => {
    const config = asFeedConfig(json);

    it('validates against the Árukereső config schema', () => {
      assertConfigValid(config, name, 'arukereso');
    });

    // The test round's KTM/Cube/Scott `filter` and its `maxItems` go on the
    // live row only. In the fixture, which the seeds push, a filter would mark
    // every run incomplete, so a hasAllProducts source would never remove an
    // offer it no longer sees.
    it('carries no test-round filter or cap', () => {
      expect(pick(config, ['filter', 'maxItems'])).toEqual({});
    });

    // An identifying source: both LLM calls run.
    it('leaves postProcess at its default', () => {
      expect(config.postProcess).toBeUndefined();
    });
  });

  describe("ambringa's Árgép feed config", () => {
    const config = asFeedConfig(ambringaArukeresoConfig);

    // The full path, matched exactly: the e-bike parts sit one level below the
    // e-bike category, and one discounted e-bike is filed under the offers.
    it.each([
      ['Elektromos kerékpár', 'ebikes'],
      ['Akciók és ajánlatok > Akciós ebike modellek', 'ebikes'],
      ['Elektromos kerékpár > Elektromos kerékpár alkatrészek és tartozékok', undefined],
      ['Rekumbens - fekvőkerékpár', undefined],
      ['Bringás webshop > Kerékpár kiegészítő', undefined],
    ])('gates the category %j to %s', async (category, slug) => {
      expect(await slugOf(config, { category })).toBe(slug);
    });

    // ShopRenter's per-row identifier, unique on all 811 rows; the sizes of a
    // bike share their title, so nothing else tells them apart.
    it('keys offers on sku and reads the GTIN from gtin', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'sku' });
      expect(config.mapping['gtin']).toEqual({ field: 'gtin' });
    });

    // Size codes shared across different BULLS bikes, and a GTIN in the MPN
    // column, would merge unrelated bikes by MPN.
    it.each([
      ['24-M', undefined],
      ['23-24-M', undefined],
      ['4063518360666', undefined],
      ['1230101111', '1230101111'],
      ['525803480845', '525803480845'],
      ['112110-54', '112110-54'],
      ['BK29431-44COLO01', 'BK29431-44COLO01'],
    ])('reads the MPN %j as %j', async (partNumber, mpn) => {
      expect(
        await readText(config, 'mpn', { manufacturer_partnumber: partNumber }),
      ).toBe(mpn);
    });

    // Only KTM's 10-digit `1YYxxxxxxx` article number carries a year, and the
    // pattern is brand-blind, so Giant's and ZEG's codes must not match it.
    // The pipeline yields two digits, which the importer reads as 20YY.
    it.each([
      ['1260167141', 2026],
      ['2303308105', undefined],
      ['5060021105', undefined],
      ['525702440855', undefined],
      ['112110-54', undefined],
    ])('reads the model year of article number %j as %j', async (partNumber, year) => {
      const releaseYear = await readText(config, 'releaseYear', {
        manufacturer_partnumber: partNumber,
      });

      expect(normalizeYear(releaseYear)).toBe(year);
    });

    it('trims "Bike" off the BULLS brand label', async () => {
      expect(await readText(config, 'brand', { manufacturer: 'BULLS Bike' })).toBe('BULLS');
      expect(await readText(config, 'brand', { manufacturer: 'KTM' })).toBe('KTM');
    });
  });

  describe("akosbike's Árukereső feed config", () => {
    const config = asFeedConfig(akosbikeArukeresoConfig);
    const newEbikes = 'Elektromos kerékpárok > Új E-bike Kerékpár > Cross, Trekking E-bike kerékpár';
    const condition = (value: string) => [{ name: 'Állapot', values: [value] }];

    it.each([
      [newEbikes, 'Új kerékpár', 'ebikes'],
      ['Cube kerékpárok > MTB kerékpár', 'Új kerékpár', undefined],
      ['Kiegészítők > Táskák és kosarak > Hátizsák', 'Új termék', undefined],
    ])('gates the category %j (Állapot %j) to %s', async (category, state, slug) => {
      expect(await slugOf(config, { category }, condition(state))).toBe(slug);
    });

    // The one demo/ex-rental bike filed with the new e-bikes stays out until
    // the user decides it may come in as new.
    it('drops a demo bike filed with the new e-bikes', async () => {
      expect(
        await slugOf(config, { category: newEbikes }, condition('új, bemutató kerékpár')),
      ).toBeUndefined();
    });

    // `identifier` is unique on every row; `sku` holds shop notes on 27% of
    // rows. It is the distributor's VLB_ code, not Cube's article number, so
    // it is no MPN either.
    it('keys offers on identifier, reads the GTIN from ean_code, and maps no MPN', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'identifier' });
      expect(config.mapping['gtin']).toEqual({ field: 'ean_code' });
      expect(config.mapping['mpn']).toBeUndefined();
    });
  });

  describe("bikelife's Árgép feed config", () => {
    const config = asFeedConfig(bikelifeArukeresoConfig);

    // The `Kerékpárok` tree mixes e-bikes with every other bike, and only the
    // shop's `0200` SKU prefix tells them apart; `0201`–`0203` are e-bike
    // parts and `1901` e-scooters. Rows outside the tree keep their own path,
    // which no rule matches.
    it.each([
      ['Kerékpárok', '020052000082', 'ebikes'],
      ['Kerékpárok > Pedelec kerékpárok', '020054000009', 'ebikes'],
      ['Kerékpárok', '020100000001', undefined],
      ['Alkatrészek > Elektromos kerékpár alkatrészek', '020100000001', undefined],
      ['Alkatrészek > Elektromos kerékpár alkatrészek', '020052000082', undefined],
      ['Kerékpárok > Elektromos roller', '190100000001', undefined],
    ])('gates the category %j with SKU %j to %s', async (category, sku, slug) => {
      expect(await slugOf(config, { category, sku })).toBe(slug);
    });

    // The feed has no `identifier`, and `sku` is unique on all 11,296 rows.
    it('keys offers on sku and reads the GTIN from gtin', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'sku' });
      expect(config.mapping['gtin']).toEqual({ field: 'gtin' });
    });

    // Kellys writes its EAN into the part-number column.
    it.each([
      ['1260149146', '1260149146'],
      ['8585053831129', undefined],
    ])('reads the MPN %j as %j', async (partNumber, mpn) => {
      expect(
        await readText(config, 'mpn', { manufacturer_partnumber: partNumber }),
      ).toBe(mpn);
    });

    it.each([
      ['1260149146', 2026],
      ['8585053831129', undefined],
    ])('reads the model year of article number %j as %j', async (partNumber, year) => {
      const releaseYear = await readText(config, 'releaseYear', {
        manufacturer_partnumber: partNumber,
      });

      expect(normalizeYear(releaseYear)).toBe(year);
    });

    // `SzállításiIdő` is 1 or 5 days on every row, never "NO".
    it('reads presence in the feed as in stock, and lets "NO" override it', async () => {
      expect(config.mapping['availability']).toEqual({
        field: 'SzállításiIdő',
        pipeline: IN_STOCK_UNLESS_NO,
      });
      expect(await readText(config, 'availability', { SzállításiIdő: '5' })).toBe('in_stock');
      expect(await readText(config, 'availability', { SzállításiIdő: 'NO' })).toBe('out_of_stock');
    });
  });

  describe("mangobike's Árukereső feed config", () => {
    const config = asFeedConfig(mangobikeArukeresoConfig);
    const navJunk = '-&nbsp;-&nbsp;start_nav&nbsp;-&nbsp;-  > ';
    const trekking =
      'Elektromos Kerékpárok > Elektromos Túra Kerékpárok > Elektromos Onroad Trekking Kerékpár';
    const ktm = 'KTM Macina Style 820 XL Machine Grey Matt';
    const imageOf = (sku: string) =>
      `https://www.mangobike.hu/_upload/images/catalog/${sku}/${sku}_bike.png`;

    // The first path segment after the navigation junk, which is stripped
    // whether the feed sends it entity-encoded, decoded or not at all. Cube's
    // cargo trikes, filed under an e-MTB category, are dropped by name.
    it.each([
      [`${navJunk}${trekking}`, ktm, 'ebikes'],
      [`${navJunk.replace(/&nbsp;/g, ' ')}${trekking}`, ktm, 'ebikes'],
      [trekking, ktm, 'ebikes'],
      [`${navJunk}Alkatrészek > Elektromos kerékpár alkatrészek > Akkumulátorok`, ktm, undefined],
      [`${navJunk}Kerékpárok > Trekking Kerékpárok`, ktm, undefined],
      [
        `${navJunk}Elektromos Kerékpárok > Elektromos MTB Kerékpárok > Elektromos Light Hardtail MTB`,
        'Cube Trike Family Hybrid 750 grey´n´reflex',
        undefined,
      ],
    ])('gates the category %j (title %j) to %s', async (category, title, slug) => {
      expect(await slugOf(config, { category, name: title })).toBe(slug);
    });

    it('keys offers on identifier', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'identifier' });
    });

    // The image folder is the size-level SKU; only KTM's (`KT-` plus the
    // 10-digit article number) is a manufacturer code, and its `1YY` prefix
    // is the model year.
    it.each([
      ['KT-1260152106', '1260152106', 2026],
      ['VB-1107672-L', undefined, undefined],
    ])('reads the MPN and model year off the image folder %j', async (sku, mpn, year) => {
      const fields = { image_url: imageOf(sku) };

      expect(await readText(config, 'mpn', fields)).toBe(mpn);
      expect(normalizeYear(await readText(config, 'releaseYear', fields))).toBe(year);
    });

    it('blanks the shop placeholder image', async () => {
      expect(
        await readText(config, 'imageUrl', {
          image_url: 'https://www.mangobike.hu/img/default-placeholder.png',
        }),
      ).toBeUndefined();
      expect(await readText(config, 'imageUrl', { image_url: imageOf('KT-1260152106') })).toBe(
        imageOf('KT-1260152106'),
      );
    });
  });

  describe("bringaboard's Árukereső feed config", () => {
    const config = asFeedConfig(bringaboardArukeresoConfig);
    const freewheel = (value: string) => [{ name: 'Cassette / freewheel', values: [value] }];

    // Two e-bike branches. The e-scooters under E-BIKE are cut by labelFrom,
    // and the Kross LIFTIE kids' bikes, which are not electric, by their
    // single-speed freewheel.
    it.each([
      ['E-BIKE > E-MTB FULLY > Unisex', [], 'ebikes'],
      ['Kerékpár > E-Bike kerékpárok > női', [], 'ebikes'],
      ['Kerékpár > E-Bike kerékpárok > férfi', freewheel('Shimano CS-M5100 11-51T'), 'ebikes'],
      ['E-BIKE > E-ROLLER', [], undefined],
      ['Akció > Kerékpárok', [], undefined],
      ['Kerékpár > E-Bike kerékpárok > gyerek', freewheel('SINGLE'), undefined],
    ])('gates the category %j (%j) to %s', async (category, attributes, slug) => {
      expect(await slugOf(config, { category }, attributes)).toBe(slug);
    });

    // Unique on all 36,641 rows; it falls back to the name where `sku` is empty.
    it('keys offers on identifier', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'identifier' });
    });

    // Some rows leave ean_code empty and carry a valid EAN-13 as their sku.
    it.each([
      ['4054571529404', '8585053831129', '4054571529404'],
      ['', '8585053831129', '8585053831129'],
      ['', 'ktm-1250041113', undefined],
    ])('reads the GTIN from ean_code %j, else the 13-digit sku %j', async (eanCode, sku, gtin) => {
      expect(await readText(config, 'gtin', { ean_code: eanCode, sku })).toBe(gtin);
    });

    // Only KTM's (`ktm-` stripped) and Giant's 10-digit article numbers are
    // manufacturer codes; every other sku is the shop's own or an EAN.
    it.each([
      ['ktm-1250041113', '1250041113'],
      ['2103235144', '2103235144'],
      ['8585053831129', undefined],
    ])('reads the MPN from sku %j as %j', async (sku, mpn) => {
      expect(await readText(config, 'mpn', { sku })).toBe(mpn);
    });

    it('drops the Árukereső tracking query from the URL', async () => {
      const page =
        'https://www.bringaboard.hu/ktm-macina-scarp-sx-prime-gx-t-type-2025-ferfi-e-bike-velvet-petrol-matt-blkgold-xl';

      expect(
        await readText(config, 'url', {
          product_url: `${page}?utm_source=arukereso&utm_medium=cpp&utm_campaign=direct_link`,
        }),
      ).toBe(page);
    });
  });
});
