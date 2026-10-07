import {
  ArukeresoMappingTarget,
  ArukeresoSourceConfig,
  ProductSourceConfig,
  ProductSourceType,
  ScrapedProductSpec,
  ScrapeOperation,
  ScrapingSourceConfig,
  ProductSourceConfigValidatorService,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import {
  ProductSpecNormalizationService,
  SpecExtractionService,
} from '@fittkereso-backend/product';
import { castArray, isArray, isEmpty, isNil, isString, pick } from 'lodash';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { registerOps } from '../ops/register-ops';
import akosbikeArukeresoConfig from './akosbike-arukereso.config.json';
import ambringaArukeresoConfig from './ambringa-arukereso.config.json';
import biciklikkArukeresoConfig from './biciklikk-arukereso.config.json';
import bikecafeGoogleshopConfig from './bikecafe-googleshop.config.json';
import bikelifeArukeresoConfig from './bikelife-arukereso.config.json';
import bringaboardArukeresoConfig from './bringaboard-arukereso.config.json';
import downhillendurokerekparArukeresoConfig from './downhillendurokerekpar-arukereso.config.json';
import ebikeshopConfig from './ebikeshop.config.json';
import k2shopArukeresoConfig from './k2shop-arukereso.config.json';
import mangobikeArukeresoConfig from './mangobike-arukereso.config.json';
import speedbikeConfig from './speedbike.config.json';
import speedbikeArukeresoConfig from './speedbike-arukereso.config.json';
import speedbikeGoogleshopConfig from './speedbike-googleshop.config.json';
import tuttobiciGoogleshopConfig from './tuttobici-googleshop.config.json';
// The size specs are read against the category's real, current schema, as
// speedbike-detail-page.spec.ts does, for the same reason.
// eslint-disable-next-line @nx/enforce-module-boundaries
import ebikesJsonSchema from '../../../../../config/src/lib/categories/ebikes/jsonSchema.json';
// eslint-disable-next-line @nx/enforce-module-boundaries
import bikesJsonSchema from '../../../../../config/src/lib/categories/bikes/jsonSchema.json';

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
    const label = isEmpty(config.category?.labelFrom)
      ? rawLabel
      : asText(
          await interpreter.runValuePipeline(config.category?.labelFrom ?? [], rawLabel, {
            baseUrl: config.baseUrl,
          }),
        );

    const resolution = interpreter.resolveCategory(
      config.categories,
      label,
      attributes,
      await readText(config, 'name', fields),
    );
    if (resolution.status === 'ambiguous') return `ambiguous: ${resolution.slugs.join(', ')}`;
    return resolution.status === 'resolved' ? resolution.slug : undefined;
  }

  /** A category section's specs for some spec rows, against that category's real schema. */
  function specsOf(config: ArukeresoSourceConfig, slug: 'bikes' | 'ebikes', rows: Record<string, string>) {
    const mapping = config.categories?.[slug]?.specMapping;
    if (!mapping) throw new Error(`The fixture has no ${slug} specMapping`);
    return new SpecExtractionService(new ProductSpecNormalizationService()).extractSpecs({
      scrapedSpecs: Object.entries(rows).map(([name, value]) => ({ name, values: [value] })),
      schema: (slug === 'bikes' ? bikesJsonSchema : ebikesJsonSchema) as unknown as SpecDefinitionJsonSchema,
      sourceConfig: mapping,
    });
  }

  /** One extraSpecRows entry's value for a feed row, read as a mapping target is. */
  async function extraRowOf(
    config: ArukeresoSourceConfig,
    slug: string,
    label: string,
    fields: Record<string, string>,
  ): Promise<string | undefined> {
    const row = config.categories?.[slug]?.extraSpecRows?.find((entry) => entry.label === label);
    if (!row) throw new Error(`The ${slug} section has no ${label} row`);
    const raw = row.field ? fields[row.field] : undefined;
    const value = isEmpty(row.pipeline)
      ? raw
      : await interpreter.runValuePipeline(row.pipeline ?? [], raw, { baseUrl: config.baseUrl });
    return asText(value);
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
    });
    expect(config.categories?.['ebikes']?.rules).toEqual([
      { when: { equalsIgnoreCase: 'elektromos-kerekparok' } },
    ]);
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
    expect(offer.mpn).toEqual([
      ...readsPath('props.product.productCode'),
      { op: 'stripPattern', pattern: '^MY\\d{2}_' },
      { op: 'stripPattern', pattern: '(?<=^\\d{6,7}-\\d{2})(?:cm|[TE])$' },
    ]);
    expect(offer.externalId).toEqual(readsPath('props.product.productCode'));
  });

  // The same Cube article and size every other shop writes: "MY26_114500-46E"
  // is 114500-46, whatever the year prefix and the frame letter.
  it.each([
    ['MY26_114500-46E', '114500-46'],
    ['MY25_814200-50T', '814200-50'],
    ['1260040108', '1260040108'],
  ])("reads ebikeshop's MPN %j as %j", async (productCode, mpn) => {
    const offer = (ebikeshopConfig as unknown as ScrapingSourceConfig).detailPage
      .offers?.itemPipeline[0] as { mpn: ScrapeOperation[] };
    const steps = offer.mpn.slice(1);
    expect(await interpreter.runValuePipeline(steps, productCode, { baseUrl: 'https://ebikeshop.hu' })).toBe(mpn);
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
      (ebikeshopConfig as unknown as ScrapingSourceConfig).categories?.['ebikes']?.identitySpecRows,
    ).toBeUndefined();
  });

  it('speedbike config resolves E-BIKE breadcrumb text to the ebikes category', () => {
    const config = speedbikeConfig as unknown as ScrapingSourceConfig;
    expect(config.categories?.['ebikes']?.rules).toEqual([
      { when: { equalsIgnoreCase: 'E-BIKE' } },
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
    it.each([
      ['4054571529404', '', '4054571529404'],
      // GIANT's 7-digit article stub is no barcode; the sku is, on 23 rows.
      ['5060018', '', undefined],
      ['', '4054624124136', '4054624124136'],
      ['', '1260040108', undefined],
    ])('reads the GTIN from ean_code %j, else the 13-digit sku %j', async (eanCode, sku, gtin) => {
      expect(await readText(config, 'gtin', { ean_code: eanCode, sku })).toBe(gtin);
    });

    // The sku is the manufacturer's article number, sometimes with an "MX"
    // prefix on KTM rows (60 of 737) that no other shop uses. Most KTM rows
    // of 2026-10 leave the sku empty and carry the article number as the
    // shop's own id instead; only a bare 10-digit one is an article number —
    // an id with a year suffix or placeholder digits is not.
    it.each([
      ['MX1260040108', '1250040108', '1260040108'],
      ['804200', '1260132506', '804200'],
      ['', '1260132506', '1260132506'],
      ['', 'KTM-12501571XX-2025', undefined],
      ['', 'KTM-0223532xx-2022-F', undefined],
      // Cube: the article and size every shop shares, not the 11-digit sku.
      ['11102000054', '1110200-50', '1110200-50'],
      ['812610', 'cube-812610-50-2025', '812610-50'],
      ['551100', 'CUBE-551100-xx-2022', '551100'],
      // Haibike and Winora rows carry their EAN as the sku.
      ['4054624124136', 'HAIBIKE-451641xx-2023', undefined],
    ])('reads the MPN from sku %j, else from the id %j: %j', async (sku, identifier, mpn) => {
      expect(await readText(config, 'mpn', { sku, identifier })).toBe(mpn);
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
      expect(config.categories?.['ebikes']?.identitySpecRows).toEqual(
        expect.arrayContaining(labels),
      );
    });

    // The mapping began as a copy of the page scraper's, but the feed labels
    // its rows its own way: on the 2026-10-05 feed 9 of those 61 mappings
    // never fired, batteryCapacity and torque among them (0% where the
    // Akkumulátor and Motor rows state them on 99% and 56%). It reads the
    // feed's labels now.
    it.each([
      ['Akkumulátor', 'Bosch PowerTUBE 800Wh horizontal', 'batteryCapacity', 800],
      ['Akkumulátor', 'Bosch PowerTube 625, Smart System', 'batteryCapacity', 625],
      ['Akku kapacitás', '625 Wh', 'batteryCapacity', 625],
      ['Motor', 'Bosch Drive Unit Performance Line 75Nm (BDU34)', 'torque', 75],
      ['Motor', 'Bosch PERFORMANCE CX BDU3840', 'torque', undefined],
      ['Súly', '27,2 kg', 'weight', 27.2],
      ['NETTÓ TÖMEG', 'TBD', 'weight', undefined],
      ['HAJTÁSRENDSZER', '2X12 SHIMANO GRX', 'gearCount', 24],
      ['Hátsó váltó', 'Shimano XT RD-M8200-SGS, ShadowPlus, 12-Speed', 'gearCount', 12],
      ['Váz', 'Aluminium Superlite, Gravity Casting Technology', 'frameMaterial', 'Alumínium'],
      ['VÁZ', 'Macina Trekking PREMIUM CARBON|CPT400 Bosch SX BDU31/T4100', 'frameMaterial', 'Karbon'],
      ['Kijelző', 'Bosch Kiox 500', 'display', true],
      ['Távvezérlő', 'Bosch Purion 200 with Integrated Display', 'display', true],
      ['CSOMAGTARTÓ', 'KTM tour snap-it 2.0/monkeyload', 'rack', 'Alapfelszereltség'],
      ['Csomagtartó', '-', 'rack', 'Nincs'],
      ['KITÁMASZTÓ', 'KTM 28" adjustable MY2025', 'kickstand', true],
      ['LEGNAGYOBB MEGENGEDETT ÖSSZTÖMEG', '146', 'maxTotalWeight', 146],
      ['Rendszer súly', 'Type 3, 150kg', 'maxTotalWeight', 150],
      ['Fék', 'Shimano BR-MT200, Hydr. Disc Brake (180/160)', 'rotorSizeRear', 160],
      ['ELSŐ GUMIABRONCS', 'Schwalbe G-One Overland Eco 45-622', 'tireSize', '45-622'],
      ['Szin', 'slabgrey´n´chrome', 'color', 'slabgrey´n´chrome'],
      ['Lengéscsillapító', 'n/a', 'rearShockModel', undefined],
    ])('reads the %s row %j as %s %j', (name, value, key, expected) => {
      expect(specsOf(config, 'ebikes', { [name]: value })[key]).toEqual(expected);
    });

    // Plan Part D: the path's wheel size agreed with the identity outputs, the
    // other shops and the titles on every listing measured (2026-10-05).
    it.each([
      ['KERÉKPÁR > MTB > Hardtail MTB > Férfi > 27.5"', 27.5],
      ['KERÉKPÁR > Gyerek kerékpár > 20" (115-135cm)', 20],
      ['KERÉKPÁR > Országúti > Női', undefined],
    ])('reads the wheel size off the path %j: %j', (path, wheelSize) => {
      expect(specsOf(config, 'bikes', { 'Webshop kategória': path })['wheelSize']).toBe(wheelSize);
    });

    // Without its gender branch: "Női" holds men's KTM frames (H) and unisex
    // road bikes, and the identity call took a wrong gender from it (test
    // round 3, 2026-10-07). The titles still state a gender where it is one.
    it.each([
      ['Termékkategóriák > KERÉKPÁR > MTB > Hardtail MTB > Férfi > 27.5"', 'KERÉKPÁR > MTB > Hardtail MTB > 27.5"'],
      ['Termékkategóriák > KERÉKPÁR > Trekking > Női', 'KERÉKPÁR > Trekking'],
      ['Termékkategóriák > E-BIKE > Trekking E-BIKE', 'E-BIKE > Trekking E-BIKE'],
    ])('sends the shop category path %j without its root and gender, as %j', async (category, row) => {
      expect(await extraRowOf(config, 'bikes', 'Webshop kategória', { category })).toBe(row);
    });

    // KTM's frame code before the size: men's diamond, women's trapeze, low
    // step. It agreed with KTM's article-number frame digit on all 705 rows
    // carrying both (2026-10-07); without it a men's "H 51" listing stated no
    // frame and joined the women's product by name.
    it.each([
      ['KTM LIFE SPACE trekking kerékpár - H 51 méretben, GREEN PURPLE FLIP MATT színben - 2027', 'Magas'],
      ['KTM MACINA STYLE 820 TRAPÉZ WHITE (BLACK+RED) D 46 NŐI ELEKTROMOS TREKKING KERÉKPÁR 2025', 'Trapéz'],
      ['KTM MACINA AERA 871 LFC Di2  US 46 Unisex elektromos MTB kerékpár MARBLE WHITE színben 2026', 'Alacsony'],
      ['KTM PENNY LANE 291 - 29" MTB kerékpár - M/43 méretben, MUTED ROSE MATT színben - 2027', undefined],
      ['Cube Aim SLX  slateblack´n´chrome M  MTB kerékpár - 2027', undefined],
    ])('reads the frame code of %j as %j', async (name, frameType) => {
      for (const slug of ['bikes', 'ebikes']) {
        const row = await extraRowOf(config, slug, 'Vázkód (cím)', { name });
        expect(row).toBe(frameType);
        if (row) expect(specsOf(config, slug as 'bikes' | 'ebikes', { 'Vázkód (cím)': row })['frameType']).toBe(frameType);
      }
    });

    // The code names the rider too (Herren, Damen, unisex); where a title also
    // states a gender it agreed every time. A frame alone left the women's
    // listing free to join a men's "H 51" product by name.
    it.each([
      ['KTM LIFE SPACE trekking kerékpár - H 51 méretben, GREEN PURPLE FLIP MATT színben - 2027', 'Férfi'],
      ['KTM LIFE SPACE trekking kerékpár - D 46 méretben, GREEN PURPLE FLIP MATT színben - 2027', 'Női'],
      ['KTM MACINA AERA 871 LFC Di2  US 46 Unisex elektromos MTB kerékpár MARBLE WHITE színben 2026', 'Uniszex'],
      ['Cube Aim SLX  slateblack´n´chrome M  MTB kerékpár - 2027', undefined],
    ])('reads the rider of the frame code in %j as %j', async (name, gender) => {
      for (const slug of ['bikes', 'ebikes']) {
        const row = await extraRowOf(config, slug, 'Nem (vázkód)', { name });
        expect(row).toBe(gender);
        if (row) expect(specsOf(config, slug as 'bikes' | 'ebikes', { 'Nem (vázkód)': row })['gender']).toBe(gender);
      }
    });

    // The feed names its Moustache bikes "Norco" or "Mavic".
    it.each([
      ['MOUSTACHE SAMEDI DIMANCHE 28.4 ROAD PEBBLE GREY 2025 FÉRFI ELEKTROMOS KERÉKPÁR', 'Norco', 'MOUSTACHE'],
      ['KTM MACINA STYLE 830 H 51 Férfi elektromos kerékpár', 'KTM', 'KTM'],
    ])('reads the brand of %j (manufacturer %j) as %j', async (name, manufacturer, brand) => {
      expect(await readText(config, 'brand', { name, manufacturer })).toBe(brand);
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
      // A rider-height range, not a 150 cm frame.
      ['Méret', 'One size 130-150 cm', {}],
    ])('reads the %s attribute %j', (name, value, expected) => {
      const ebikes = config.categories?.['ebikes']?.specMapping;
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
      expect(config.categories?.['ebikes']?.rules).toEqual(
        (speedbikeConfig as unknown as ScrapingSourceConfig).categories?.['ebikes']?.rules,
      );
    });

    // Cube's framesets sit among the road bikes, and say so only in the title.
    it.each([
      ['Termékkategóriák > E-BIKE > Trekking E-BIKE', 'KTM MACINA STYLE 720 2025 TREKKING E-BIKE', 'ebikes'],
      ['Termékkategóriák > KERÉKPÁR > Országúti > Női', 'Cube Attain Pro 58 cm országúti kerékpár - 2027', 'bikes'],
      ['Termékkategóriák > KERÉKPÁR', 'KTM WILD CROSS 16 FIRE ORANGE (WHITE) 2023 GYEREK KERÉKPÁR', 'bikes'],
      ['Termékkategóriák > KERÉKPÁR > Országúti > Női', 'Cube Litening AIR C:68X Frameset graphic´n´white 58 cm országúti kerékpár - 2027', undefined],
      ['Termékkategóriák > ALKATRÉSZ > Váz', 'Cube frame', undefined],
    ])('gates the category %j (title %j) to %s', async (category, name, slug) => {
      expect(await slugOf(config, { category, name })).toBe(slug);
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

    // The same label and the same e-bike rules; the spec mapping and the
    // identity rows are no use to a source that runs neither LLM call. Its
    // bikes stay off: the shop's Google feed carries its e-bikes only.
    it('resolves e-bikes as the Árukereső source does, and takes no bikes', () => {
      const gate = (section: unknown) => pick(section, ['enabled', 'rules']);
      expect(config.category).toEqual(arukereso.category);
      expect(gate(config.categories?.['ebikes'])).toEqual(gate(arukereso.categories?.['ebikes']));
      expect(gate(config.categories?.['bikes'])).toEqual({ enabled: false });
    });

    // It identifies nothing and carries no specs: no LLM call has anything to do.
    it('turns both LLM calls off', () => {
      expect(config.postProcess).toEqual({ identity: false, specs: false });
    });
  });

  // Wave 1 of the e-bike shop onboarding (docs/webshops/plans/): five shops
  // (2026-10-02), then the next five (#11–#15, 2026-10-07), each with one
  // identifying feed. tuttobici and bikecafe identify from a Google Shopping
  // TSV.
  describe.each([
    ['ambringa-arukereso', ambringaArukeresoConfig, 'arukereso'],
    ['akosbike-arukereso', akosbikeArukeresoConfig, 'arukereso'],
    ['bikelife-arukereso', bikelifeArukeresoConfig, 'arukereso'],
    ['mangobike-arukereso', mangobikeArukeresoConfig, 'arukereso'],
    ['bringaboard-arukereso', bringaboardArukeresoConfig, 'arukereso'],
    ['tuttobici-googleshop', tuttobiciGoogleshopConfig, 'googleshop'],
    ['downhillendurokerekpar-arukereso', downhillendurokerekparArukeresoConfig, 'arukereso'],
    ['bikecafe-googleshop', bikecafeGoogleshopConfig, 'googleshop'],
    ['biciklikk-arukereso', biciklikkArukeresoConfig, 'arukereso'],
    ['k2shop-arukereso', k2shopArukeresoConfig, 'arukereso'],
  ] as const)('wave-1 feed config %s', (name, json, type) => {
    const config = asFeedConfig(json);

    it(`validates against the ${type} config schema`, () => {
      assertConfigValid(config, name, type);
    });

    // The test round's KTM/Cube/Scott `filter` and its `maxItems` go on the
    // live row only. In the fixture, which the seeds push, a filter would mark
    // every run incomplete, so a hasAllProducts source would never remove an
    // offer it no longer sees.
    it('carries no test-round filter or cap', () => {
      expect(pick(config, ['filter', 'maxItems'])).toEqual({});
    });

    // An identifying source: both LLM calls run.
    it('leaves both LLM calls on', () => {
      expect(config.postProcess?.identity).not.toBe(false);
      expect(config.postProcess?.specs).not.toBe(false);
    });

    // Only where the measured excerpts added usage types (bikelife's and
    // akosbike's descriptions name them; ambringa's are brand talk, and
    // mangobike's titles already name them): plan vivid-skipping-hopper.md.
    // tuttobici's descriptions are the bike type itself, and k2shop's titles
    // name it on 39 of 225 e-bikes while its descriptions open with it.
    it('sends the identity extraction description excerpts only where they help', () => {
      const evidence = ['akosbike-arukereso', 'bikelife-arukereso', 'tuttobici-googleshop', 'k2shop-arukereso'].includes(
        name,
      );
      expect(config.postProcess?.identityDescription).toEqual(
        evidence ? { mode: 'evidence' } : undefined,
      );
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
      ['111122-46E', '111122-46'],
      ['111121-50T', '111121-50'],
      ['BK29431-44COLO01', 'BK29431-44COLO01'],
    ])('reads the MPN %j as %j', async (partNumber, mpn) => {
      expect(
        await readText(config, 'mpn', { manufacturer_partnumber: partNumber }),
      ).toBe(mpn);
    });

    // KTM's year is read off the MPN by the ebikes brand rule
    // (brandIdentifierSpecs), which only a KTM listing's MPN reaches.
    it('reads no year of its own', () => {
      expect(config.mapping['releaseYear']).toBeUndefined();
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
      ['Cube kerékpárok > MTB kerékpár', 'Új kerékpár', 'bikes'],
      ['Cube kerékpárok > 20" gyerek kerékpár', 'Új kerékpár', 'bikes'],
      // Used and demo bikes stay out among the bikes too.
      ['Cube kerékpárok > MTB kerékpár', 'használt kerékpár', undefined],
      ['Kiegészítők > Szállítás és tárolás > Utánfutó', 'Új termék', undefined],
      ['Kiegészítők > Táskák és kosarak > Hátizsák', 'Új termék', undefined],
    ])('gates the category %j (Állapot %j) to %s', async (category, state, slug) => {
      expect(await slugOf(config, { category }, condition(state))).toBe(slug);
    });

    it('drops a frame set filed with the road bikes', async () => {
      expect(
        await slugOf(
          config,
          { category: 'Cube kerékpárok > Országúti kerékpár', name: 'Cube Litening Air C:68X Team ICW 2024 vázszett 58 cm' },
          condition('Új kerékpár'),
        ),
      ).toBeUndefined();
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
    it('keys offers on identifier and reads the GTIN from ean_code', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'identifier' });
      expect(config.mapping['gtin']).toEqual({ field: 'ean_code' });
    });

    // `VLB_` is the distributor's prefix; what follows is the Cube article and
    // size the other shops write, the size's cm or frame letter aside.
    it.each([
      ['VLB_1110200-50', '1110200-50'],
      ['VLB_860301-46T', '860301-46'],
      ['VLB_860200-50cm', '860200-50'],
      ['VLB_845700-XL', '845700-XL'],
      ['VLB_T377-750', undefined],
    ])('reads the MPN from identifier %j as %j', async (identifier, mpn) => {
      expect(await readText(config, 'mpn', { identifier })).toBe(mpn);
    });
  });

  describe("bikelife's Árgép feed config", () => {
    const config = asFeedConfig(bikelifeArukeresoConfig);

    // The `Kerékpárok` tree mixes e-bikes with every other bike, and only the
    // shop's `0200` SKU prefix tells them apart; `0201`–`0203` are e-bike
    // parts and `1901` e-scooters. Rows outside the tree keep their own path,
    // which no rule matches.
    // Its bikes are `01xx`, minus trailers (`0111`), adult tricycles (`0113`)
    // and scooter parts (`0114`).
    it.each([
      ['Kerékpárok', '020052000082', 'ebikes'],
      ['Kerékpárok > Pedelec kerékpárok', '020054000009', 'ebikes'],
      ['Kerékpárok', '010500000001', 'bikes'],
      ['Kerékpárok > Gyerek kerékpárok', '010100000001', 'bikes'],
      ['Kerékpárok > Utánfutók', '011100000001', undefined],
      ['Kerékpárok', '011300000001', undefined],
      ['Kerékpárok > Speciális kerékpárok', '011400000001', undefined],
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
      ['NE2292411020', 'NE2292411020'],
      ['94531221BK', '94531221BK'],
      ['286290-006', '286290-006'],
      ['KITE RACE 12', undefined],
      ['SPIDER', undefined],
    ])('reads the MPN %j as %j', async (partNumber, mpn) => {
      expect(
        await readText(config, 'mpn', { manufacturer_partnumber: partNumber }),
      ).toBe(mpn);
    });

    // KTM's 10- and 9-digit article numbers are MPNs; the ebikes brand rule
    // reads the year off them.
    it('reads no year of its own, and keeps KTM\'s 9-digit article number as the MPN', async () => {
      expect(config.mapping['releaseYear']).toBeUndefined();
      expect(await readText(config, 'mpn', { manufacturer_partnumber: '025163108' })).toBe(
        '025163108',
      );
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
      [`${navJunk}Kerékpárok > Túra Kerékpárok > Onroad Trekking Kerékpár`, 'KTM Life Joy Trekking Kerékpár - fekete', 'bikes'],
      // An e-bike filed among the bikes says so in its title.
      [
        `${navJunk}Kerékpárok > Összecsukható Kerékpárok`,
        'KTM Macina Fold 20 500Wh Összecsukható Elektromos Városi Kerékpár - Olive Pearl - zöld',
        'ebikes',
      ],
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

    // The image folder is the size-level SKU; only KTM's (`KT-` plus its
    // 10-digit e-bike or bike article number, or a 9-digit one) is a
    // manufacturer code. The category brand rules read the model year off it.
    it.each([
      ['KT-1260152106', '1260152106'],
      ['KT-2260452119', '2260452119'],
      ['KT-023826211', '023826211'],
      ['VB-1107672-L', '1107672-L'],
      ['VB-150170-12', '150170-12'],
      ['BF-2402882', '2402882'],
      ['CS-94253614BK', '94253614BK'],
      ['KR-KRLV2Z29X19M002326', 'KRLV2Z29X19M002326'],
      ['OR-S11053AJ', undefined],
      ['SC-4254390002008', undefined],
    ])('reads the MPN off the image folder %j', async (sku, mpn) => {
      expect(await readText(config, 'mpn', { image_url: imageOf(sku) })).toBe(mpn);
    });

    // Merida's and Orbea's image file names carry a year, but a file name is
    // not a manufacturer's statement: the user ruled it out (2026-10-05).
    it('reads no year of its own', () => {
      expect(config.mapping['releaseYear']).toBeUndefined();
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
      // So they are bikes.
      ['Kerékpár > E-Bike kerékpárok > gyerek', freewheel('SINGLE'), 'bikes'],
      ['Kerékpár > Mountain Bike > Mountain Bike 29 > férfi', [], 'bikes'],
      ['Kerékpár > Speciális Kerékpárok > Roller', [], undefined],
    ])('gates the category %j (%j) to %s', async (category, attributes, slug) => {
      expect(await slugOf(config, { category }, attributes)).toBe(slug);
    });

    // The sale path holds bikes and e-bikes alike, told apart by the title;
    // Koliken's toy motorbikes sit among the balance bikes.
    it.each([
      ['Akció > Kerékpárok', 'Giant Yukon 2 2022 Fatbike knight shield L', 'bikes'],
      ['Akció > Kerékpárok', 'NORCO Range VLT A2 29 férfi E-bike Dark Green M', 'ebikes'],
      ['Akció > Kerékpárok', 'Bergamont E-Cargoville LJ Load Unit unisex E-bike rakodóegység 50cm', undefined],
      ['Akció > Kerékpárok', 'Ajándékutalvány', undefined],
      ['Kerékpár > Gyerek Kerékpár > Futókerékpár', 'Koliken műanyag kismotor M fehér-ciklámen', undefined],
      ['Kerékpár > Gyerek Kerékpár > Futókerékpár', 'Cardamo 12 futókerékpár - rózsaszín', 'bikes'],
    ])('gates the category %j (title %j) to %s', async (category, name, slug) => {
      expect(await slugOf(config, { category, name })).toBe(slug);
    });

    // Liv is its own brand; the shop lists it under Giant, titled "Giant Liv …".
    it.each([
      ['Giant Liv Tempt 29 4 2022 női Mountain Bike black chrome M', 'Giant', 'Liv'],
      ['Giant Yukon 2 2022 Fatbike knight shield L', 'Giant', 'Giant'],
      ['Neuzer Ravenna 50 férfi Trekking Kerékpár', 'Neuzer kerékpár', 'Neuzer'],
    ])('reads the brand of %j (manufacturer %j) as %j', async (name, manufacturer, brand) => {
      expect(await readText(config, 'brand', { name, manufacturer })).toBe(brand);
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

    // Only KTM's (`ktm-` stripped) and Giant's 10-digit article numbers and
    // CTM's (`224-286`, its first digits the year) are manufacturer codes;
    // every other sku is the shop's own or an EAN.
    it.each([
      ['ktm-1250041113', '1250041113'],
      ['2103235144', '2103235144'],
      ['224-286', '224-286'],
      ['8585053831129', undefined],
      ['ne-NE2561612023', undefined],
      ['bf-2201733', '2201733'],
      ['94253614BK', '94253614BK'],
      ['KRTR2Z28X19M002501', 'KRTR2Z28X19M002501'],
      // Norco's 10-digit sku is the shop's own.
      ['0670821702', undefined],
    ])('reads the MPN from sku %j as %j', async (sku, mpn) => {
      expect(await readText(config, 'mpn', { sku })).toBe(mpn);
    });

    // Some brands' rows state the year, under five labels (2026-10-05:
    // 378 bikes, mostly CTM, Pells, LOOK and Norco).
    it.each([
      ['Évjárat', '2024', 2024],
      ['Year', '2025', 2025],
      ['Modell év', '2022', 2022],
      ['Modellév', '2022', 2022],
    ])('reads the year from a %s row, for bikes and e-bikes', (name, value, year) => {
      for (const [slug, schema] of [
        ['bikes', bikesJsonSchema],
        ['ebikes', ebikesJsonSchema],
      ] as const) {
        const mapping = config.categories?.[slug]?.specMapping;
        if (!mapping) throw new Error(`The fixture has no ${slug} specMapping`);
        const specs = new SpecExtractionService(new ProductSpecNormalizationService()).extractSpecs({
          scrapedSpecs: [{ name, values: [value] }],
          schema: schema as unknown as SpecDefinitionJsonSchema,
          sourceConfig: mapping,
        });
        expect(specs['modelYear']).toBe(year);
      }
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

  // Plan vivid-skipping-hopper.md, Phase 4: each feed shop's category sections.
  describe.each([
    ['speedbike-arukereso', speedbikeArukeresoConfig],
    ['speedbike-googleshop', speedbikeGoogleshopConfig],
    ['ambringa-arukereso', ambringaArukeresoConfig],
    ['akosbike-arukereso', akosbikeArukeresoConfig],
    ['bikelife-arukereso', bikelifeArukeresoConfig],
    ['mangobike-arukereso', mangobikeArukeresoConfig],
    ['bringaboard-arukereso', bringaboardArukeresoConfig],
    ['tuttobici-googleshop', tuttobiciGoogleshopConfig],
    ['downhillendurokerekpar-arukereso', downhillendurokerekparArukeresoConfig],
    ['bikecafe-googleshop', bikecafeGoogleshopConfig],
    ['biciklikk-arukereso', biciklikkArukeresoConfig],
    ['k2shop-arukereso', k2shopArukeresoConfig],
  ])('category sections of %s', (name, json) => {
    const config = asFeedConfig(json);
    const schemaKeys: Record<string, Set<string>> = {
      bikes: new Set(Object.keys(bikesJsonSchema.properties)),
      ebikes: new Set(Object.keys(ebikesJsonSchema.properties)),
    };

    // ambringa sells e-bikes only, and speedbike's Google feed carries its
    // e-bikes only; every other shop takes its bikes.
    it('switches bikes on with rules, where the feed has bikes', () => {
      const bikes = config.categories?.['bikes'];
      if (name === 'ambringa-arukereso') expect(bikes).toBeUndefined();
      else if (name === 'speedbike-googleshop') expect(pick(bikes, ['enabled', 'rules'])).toEqual({ enabled: false });
      else {
        expect(bikes?.enabled).toBe(true);
        expect(bikes?.rules?.length).toBeGreaterThan(0);
      }
    });

    it('maps only specs its category has', () => {
      for (const [slug, section] of Object.entries(config.categories ?? {})) {
        const keys = (section.specMapping?.mappings ?? []).map((mapping) => mapping.key);
        expect(keys.filter((key) => !schemaKeys[slug].has(key))).toEqual([]);
      }
    });

    // One list per shop: a row both categories read is read the same way.
    it('maps a spec both categories have the same way in both', () => {
      const ebikes = config.categories?.['ebikes']?.specMapping?.mappings ?? [];
      const bikes = config.categories?.['bikes']?.specMapping?.mappings ?? [];
      if (!bikes.length) return;
      expect(bikes.filter((mapping) => schemaKeys['ebikes'].has(mapping.key))).toEqual(
        ebikes.filter((mapping) => schemaKeys['bikes'].has(mapping.key)),
      );
    });

    // An extra row exists for the identity call; a list that leaves it out
    // would drop it there.
    it('sends its extra rows to the identity extraction', () => {
      for (const section of Object.values(config.categories ?? {})) {
        if (!section.identitySpecRows || !section.extraSpecRows) continue;
        expect(section.identitySpecRows).toEqual(
          expect.arrayContaining(section.extraSpecRows.map((row) => row.label)),
        );
      }
    });
  });

  describe("akosbike's spec rows", () => {
    const config = asFeedConfig(akosbikeArukeresoConfig);

    it.each([
      ['bikes', 'Váz kialakítás', 'Trapéz', 'frameType', 'Trapéz'],
      ['bikes', 'Váz', 'C:62® Advanced Twin Mold Technology', 'frameMaterial', 'Karbon'],
      ['bikes', 'Ajánlott gyártói magasság', '118  - 136 cm (átlépési magasság : 52 - 63 cm)', 'recommendedRiderHeight', '118  - 136 cm'],
      ['bikes', 'Ajánlott gyártói magasság', '118  - 136 cm (átlépési magasság : 52 - 63 cm)', 'standoverHeight', '52 - 63 cm'],
      ['bikes', 'Ajánlott magasság', 'kb. 115-130 cm (6-8 éves korosztály)', 'recommendedAge', '6-8 év'],
      ['bikes', 'Első váltó', 'nincs', 'frontDerailleur', undefined],
      ['ebikes', 'Csomagtartó', 'ACID SIC 2.1 RILink', 'rack', 'Alapfelszereltség'],
      ['ebikes', 'Első lámpa', 'nincs', 'lighting', 'Nincs'],
      ['ebikes', 'Kezelőszerv', 'Bosch Purion 200 with Integrated Display', 'display', true],
      // The wheel size a kids' path names, when it names one.
      ['bikes', 'Webshop kategória', 'Cube kerékpárok > 20" gyerek kerékpár', 'wheelSize', 20],
      ['bikes', 'Webshop kategória', 'Cube kerékpárok > 24", 26" gyerek kerékpár', 'wheelSize', undefined],
    ] as const)('reads a %s row %s: %j as %s %j', (slug, name, value, key, expected) => {
      expect(specsOf(config, slug, { [name]: value })[key]).toEqual(expected);
    });
  });

  describe("bringaboard's spec rows", () => {
    const config = asFeedConfig(bringaboardArukeresoConfig);

    it.each([
      // Chainrings × sprockets.
      ['bikes', 'Sebességek száma', '2x10', 'gearCount', 20],
      ['ebikes', 'Sebesség', '1*10', 'gearCount', 10],
      ['bikes', 'DRIVE', '24 gears', 'gearCount', 24],
      ['bikes', 'Anyag', 'alu', 'frameMaterial', 'Alumínium'],
      ['bikes', 'Anyag', 'Hliník', 'frameMaterial', 'Alumínium'],
      ['bikes', 'VÁZ', 'HI-TEN ACÉL/STEEL', 'frameMaterial', 'Acél'],
      ['bikes', 'EXTRÁK', 'VILÁGÍTÁS, SÁRVÉDŐ, CSOMAGTARTÓ/LIGHTING, MUDGUARDS, CARRIER', 'rack', 'Alapfelszereltség'],
      ['bikes', 'EXTRÁK', '-', 'rack', undefined],
      ['bikes', 'Méret', '130-150 cm', 'frameSize', undefined],
      ['bikes', 'Pedálok', 'N/A', 'pedals', undefined],
      ['ebikes', 'Kitámasztó', 'ÁLLÍTHATÓ', 'kickstand', true],
      // Colour as the shop writes it.
      ['bikes', 'Szín(ek)', 'Stealth Black', 'color', 'Stealth Black'],
      // The wheel size its path names (plan Part D: 100% against the identity
      // outputs, the other shops and the titles, 2026-10-05).
      ['bikes', 'Webshop kategória', 'Kerékpár > Mountain Bike > Mountain Bike 27,5 Fully > férfi', 'wheelSize', 27.5],
      ['bikes', 'Webshop kategória', 'Kerékpár > Gyerek Kerékpár > Gyerek kerékpár 16', 'wheelSize', 16],
      ['bikes', 'Webshop kategória', 'Kerékpár > Országúti kerékpár > férfi', 'wheelSize', undefined],
    ] as const)('reads a %s row %s: %j as %s %j', (slug, name, value, key, expected) => {
      expect(specsOf(config, slug, { [name]: value })[key]).toEqual(expected);
    });

    it('lets a wheel-size row decide over the path', () => {
      expect(
        specsOf(config, 'bikes', {
          'Webshop kategória': 'Kerékpár > Mountain Bike > Mountain Bike 27,5 > női',
          Kerékméret: '29',
        })['wheelSize'],
      ).toBe(29);
    });
  });

  describe("bikelife's bike type", () => {
    const config = asFeedConfig(bikelifeArukeresoConfig);

    // Its category is flat; the sku's first four digits name the bike type.
    it.each([
      ['010612345678', 'Cross Trekking'],
      ['012012345678', 'MTB 29"'],
      // Trailers and adult tricycles: no bike type.
      ['011112345678', undefined],
      ['020012345678', undefined],
    ])('reads sku %s as %j', async (sku, row) => {
      expect(await extraRowOf(config, 'bikes', 'Webshop kategória', { sku })).toBe(row);
    });
  });

  describe("ambringa's spec rows", () => {
    const config = asFeedConfig(ambringaArukeresoConfig);

    // The sku's suffix: the frame, or a full-suspension or folding bike.
    it.each([
      ['LEVIT-MUAN-MX3_df', 'Váz kialakítás', 'Magas'],
      ['KTM-MACINA-SPORT_tf', 'Váz kialakítás', 'Trapéz'],
      ['CUBE-NURIDE_cf', 'Váz kialakítás', 'Alacsony'],
      ['CUBE-STEREO_fs', 'Webshop kategória', 'Összteleszkópos MTB'],
      ['CUBE-STEREO_fs', 'Váz kialakítás', undefined],
    ])('reads sku %s as %s %j', async (sku, label, row) => {
      expect(await extraRowOf(config, 'ebikes', label, { sku })).toBe(row);
    });

    // The suffix agrees with KTM's frame digit and Cube's E/T sizes, so the
    // frame it names is fixed for the identity call (plan Part D).
    it.each(['Magas', 'Trapéz', 'Alacsony'])('takes the frame %j its sku names as given', (frame) => {
      expect(specsOf(config, 'ebikes', { 'Váz kialakítás': frame })['frameType']).toBe(frame);
    });

    // Never the torque: the description template says 85 Nm on every Bosch CX
    // bike, where the other shops give 100 or 120 (test round 3, 2026-10-07).
    it("reads the description's motor lines, never the torque, a weight or the capacity", async () => {
      const description =
        '<em>Működési elv:</em> Nyomatékszenzor<br />\n\t\t<em>Csúcsnyomatéka:</em> 85Nm<br />\n\t\t<em>Tömege:</em> 2,9 kg</span>';

      expect(await extraRowOf(config, 'ebikes', 'Motor működési elve', { description })).toBe('Nyomatékszenzor');
      expect(JSON.stringify(config.categories?.['ebikes']?.extraSpecRows)).not.toMatch(/Kapacitás|Tömeg|Csúcsnyomaték/);
    });
  });

  describe("mangobike's category path", () => {
    const config = asFeedConfig(mangobikeArukeresoConfig);

    it('drops the menu marker its path starts with', async () => {
      expect(
        await extraRowOf(config, 'bikes', 'Webshop kategória', {
          category: '-&nbsp;-&nbsp;start_nav&nbsp;-&nbsp;-  > Kerékpárok > Országúti és Gravel Kerékpárok > Országúti Kerékpár',
        }),
      ).toBe('Kerékpárok > Országúti és Gravel Kerékpárok > Országúti Kerékpár');
    });
  });

  // tuttobici.hu (ticket #11): the first Google Shopping feed that identifies
  // products on its own. Its feed has no attribute table and its descriptions
  // are mostly a category phrase, so the gate, the identifiers and two extra
  // rows are what the config adds to the titles.
  describe("tuttobici's Google Shopping feed config", () => {
    const config = asFeedConfig(tuttobiciGoogleshopConfig);
    const stripCurrency = [{ op: 'stripPattern', pattern: '\\s*[A-Z]{3}$' }];

    it('validates against the feed config schema', () => {
      assertConfigValid(config, 'tuttobici-googleshop', 'googleshop');
    });

    // The test round's id list and cap go on the live row only.
    it('carries no test-round filter or cap', () => {
      expect(pick(config, ['filter', 'maxItems'])).toEqual({});
    });

    // An identifying source: both LLM calls run. The descriptions are the
    // shop's bike type ("Összteleszkópos elektromos MTB kerékpár"), which the
    // excerpts pass on.
    it('leaves both LLM calls on and sends description excerpts', () => {
      expect(config.postProcess).toEqual({ identityDescription: { mode: 'evidence' } });
    });

    // E-bikes are the `Elektromos kerékpárok` branch, plus 22 e-bikes the shop
    // filed among its other bikes, which say "elektromos" in the title. The
    // bikes are the rest of `Kerékpár`, minus frame sets, a LEGO set and two
    // DT Swiss tools filed there. Parts, clothing and accessories have their
    // own top-level paths (`Kerékpár alkatrészek`, `Kerékpáros ruházat`, …).
    it.each([
      [
        'Kerékpár > Elektromos kerékpárok > Trekking E-BIKE',
        'KTM MACINA STYLE 820 FÉRFI Elektromos trekking- túra kerékpár - MACHINE GREY - több méretben',
        'ebikes',
      ],
      ['Kerékpár > Elektromos kerékpárok', 'Liv Avail Advanced E+ EL 0  - női elektromos országúti kerékpár - 2025', 'ebikes'],
      [
        'Kerékpár > Férfi kerékpár > Összteleszkópos > 27.5"',
        'KTM MACINA CROSS CX 820 L NŐI Elektromos crosstrekking kerékpár - FLAMING GREY - több méretben',
        'ebikes',
      ],
      ['Kerékpár > Női kerékpár > MTB', 'LIV Lurra E+ 29" elektromos női MTB kerékpár - Lunar Eclipse', 'ebikes'],
      [
        'Kerékpár > Férfi kerékpár > Gravel',
        'Bottecchia 47BE GRAVEL MONSTER Shimano GRX610 12s DISK Gravel kerékpár - 2026 MATT GREY',
        'bikes',
      ],
      ['Kerékpár > Gyerek kerékpárok > 20" (7-9 éves korig)', 'GIANT ARX 20   gyermek cross/gravel kerékpár - Cobalt', 'bikes'],
      ['Kerékpár > Cargo', 'Tern Link B7 összecsukható kerékpár', 'bikes'],
      [
        'Kerékpár > Férfi kerékpár > Férfi országúti kerékpár (700, 622, 28")',
        'GIANT TCR Advanced Pro-FF férfi országúti kerékpár vázszett - Carnival',
        undefined,
      ],
      ['Kerékpár > Női kerékpár > Országúti (700, 622, 28")', 'LEGO® Icons Országúti kerékpár #11380', undefined],
      ['Kerékpár > Gyerek kerékpárok > 20" (7-9 éves korig)', 'Küllőfogó DT Swiss Aero küllőkhöz 0.8-1.0mm piros ÚJ', undefined],
      ['Kerékpár > Extrém kerékpárok', 'Agytest bontó DT Swiss Ratchet DEG agyakhoz', undefined],
      ['Kerékpár alkatrészek > Markolat', 'Markolat Ergon komfort GP1-S Gripshift fém bilincses szarv nélkül fekete', undefined],
      [
        'Kerékpáros ruházat > Bukósisak',
        'Kerékpáros bukósisak THE WING WHITE S-M 55-58 - LASER BLACK LENCSÉVEL',
        undefined,
      ],
    ])('gates the category %j (title %j) to %s', async (productType, title, slug) => {
      expect(await slugOf(config, { product_type: productType, title })).toBe(slug);
    });

    // `id` is unique on all 3,435 rows; `item_group_id` is empty on the bikes.
    it('keys offers on id', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'id' });
    });

    // Google's price is the list price; sale_price, when there is one, is what
    // the shop charges. "2359000 HUF" is no number without the strip.
    it('takes the sale price, else the price, and the price as the old price', async () => {
      expect(config.mapping['price']).toEqual([
        { field: 'sale_price', pipeline: stripCurrency },
        { field: 'price', pipeline: stripCurrency },
      ]);
      expect(config.mapping['priceWithoutDiscount']).toEqual({ field: 'price', pipeline: stripCurrency });
      expect(await readText(config, 'price', { sale_price: '559992 HUF', price: '699990 HUF' })).toBe('559992');
      expect(await readText(config, 'price', { sale_price: '', price: '2359000 HUF' })).toBe('2359000');
    });

    // KTM's EAN and 10-digit article number (the category brand rules read its
    // year and frame off the latter), Giant's article number with its W. The
    // shop types the model year into `gtin` on its 2026 Giant and Liv rows:
    // that is no GTIN.
    it.each([
      ['9008594506329', '9008594506329'],
      ['4711291060708', '4711291060708'],
      ['2026', undefined],
      ['', undefined],
    ])('reads the GTIN %j as %j', async (gtin, expected) => {
      expect(await readText(config, 'gtin', { gtin })).toBe(expected);
    });

    it.each([
      ['1260154106', '1260154106'],
      ['5090000104W', '5090000104W'],
      ['74A', '74A'],
    ])('reads the MPN %j as published', async (mpn, expected) => {
      expect(await readText(config, 'mpn', { mpn })).toBe(expected);
    });

    // The year the shop typed into `gtin` reaches the identity extraction as a
    // row of its own, in both categories; a real GTIN gives no row.
    it.each(['ebikes', 'bikes'])('turns the year in gtin into a Modellév row (%s)', async (slug) => {
      expect(await extraRowOf(config, slug, 'Modellév', { gtin: '2026' })).toBe('2026');
      expect(await extraRowOf(config, slug, 'Modellév', { gtin: '9008594506329' })).toBeUndefined();
      expect(await extraRowOf(config, slug, 'Modellév', { gtin: '' })).toBeUndefined();
    });

    // Liv's 2025 and Bottecchia's 2026 titles state their year; KTM's never do
    // (its article number does).
    it.each([
      ['Liv Amiti E+ 2 - női elektromos trekking kerékpár - 2025', '2025'],
      ['Bottecchia 52BX GRAVEL TITAN SHIMANO GRX 610 24S - 2026', '2026'],
      ['KTM MACINA GRAN 830 FÉRFI Elektromos trekking- túra kerékpár - MACHINE GREY MATT - több méretben', undefined],
    ])('reads the model year off the title %j as %j', async (title, year) => {
      expect(await readText(config, 'releaseYear', { title })).toBe(year);
    });

    // The e-bike branch's own sub-category only: an e-bike filed under a bike
    // path ("Férfi kerékpár > Összteleszkópos > 27.5"" for a cross-trekking
    // KTM) sends no row rather than a wrong one. Bikes keep the whole path
    // below `Kerékpár`, gender included.
    it('sends the shop category as a row', async () => {
      expect(
        await extraRowOf(config, 'ebikes', 'Webshop kategória', {
          product_type: 'Kerékpár > Elektromos kerékpárok > Trekking E-BIKE',
        }),
      ).toBe('Trekking E-BIKE');
      expect(
        await extraRowOf(config, 'ebikes', 'Webshop kategória', {
          product_type: 'Kerékpár > Férfi kerékpár > Összteleszkópos > 27.5"',
        }),
      ).toBeUndefined();
      expect(
        await extraRowOf(config, 'bikes', 'Webshop kategória', {
          product_type: 'Kerékpár > Férfi kerékpár > Gravel',
        }),
      ).toBe('Férfi kerékpár > Gravel');
    });

    // Every row says in_stock and New: availability is read as Google writes
    // it, and condition is left to the default.
    it('reads availability as written and maps no condition', async () => {
      expect(config.mapping['availability']).toEqual({ field: 'availability' });
      expect(config.mapping['condition']).toBeUndefined();
    });
  });

  describe("downhillendurokerekpar's Árukereső feed config", () => {
    const config = asFeedConfig(downhillendurokerekparArukeresoConfig);
    const newBike = 'A META SX V5-öt előbb vezetik, mielőtt megülne. A 165 mm-es rugóút…';

    it('validates against the Árukereső config schema', () => {
      assertConfigValid(config, 'downhillendurokerekpar-arukereso', 'arukereso');
    });

    // The test round's id filter and cap go on the live row only.
    it('carries no test-round filter or cap, and leaves both LLM calls on', () => {
      expect(pick(config, ['filter', 'maxItems'])).toEqual({});
      expect(config.postProcess?.identity).not.toBe(false);
      expect(config.postProcess?.specs).not.toBe(false);
    });

    // StartÜzlet's own category values, matched whole once a trailing
    // "> Kerékpárok" or kids' wheel size is cut. Frame sets sit among the bikes
    // (and once among the e-bikes) and say so only in the title; Specialized's
    // Turbo e-bikes sit among the gravel bikes.
    it.each([
      ['E-BIKE', '2026 Specialized  Turbo Levo 4 Comp Ebike', 'ebikes'],
      ['E-BIKE', 'COMMENCAL META HT 24 POWER GLITTERY WHITE Ebike Gyerek Kerékpár', 'ebikes'],
      ['E-BIKE', 'UNNO MITH Vázszett', undefined],
      ['GRAVEL', '2026 Specialized Turbo Creo 2 Comp E5 SRAM Apex Gravel Kerékpár', 'ebikes'],
      ['GRAVEL', '2026 Specialized Diverge 4 Comp Alloy Sram Gravel Kerékpár', 'bikes'],
      ['GRAVEL', '2026 Specialized Sirrus X 2.0 Step-Through', 'bikes'],
      ['ALL-MOUNTAIN', '2026 SCOTT Spark 920 Trail Kerékpár', 'bikes'],
      ['ALL-MOUNTAIN', '2026 Specialized Chisel Vázszett', undefined],
      ['ALL-MOUNTAIN', '2025 Specialized Chisel Váz Szett', undefined],
      ['ALL-MOUNTAIN', 'Unno Horn XC Kerékpár Vázszett', undefined],
      ['DIRT', '2026 COMMENCAL ABSOLUT PURE WHITE Dirt Kerékpár', 'bikes'],
      ['DOWNHILL > Kerékpárok', '2026 SCOTT Gambler 20 Downhill Kerékpár', 'bikes'],
      ['DOWNHILL', '2027 Santa Cruz V10 Downhill Kerékpár', 'bikes'],
      ['ENDURO > Kerékpárok', '2027 Santa Cruz Bronson 70 Enduro Kerékpár', 'bikes'],
      // A shop typo in a title, not an e-bike: the category decides.
      ['ENDURO > Kerékpárok', '2026 Ghost Riot Trail CF Dirt E-bike', 'bikes'],
      ['ENDURO', '2027 Santa Cruz Megatower 70 Enduro Kerékpár', 'bikes'],
      ['GYEREK MTB > 20"', '2026 COMMENCAL RAMONES 20 BLACK Gyerek Kerékpár', 'bikes'],
      ['GYEREK MTB > 12"', '2026 COMMENCAL RAMONES 12 PUSH BIKE GREEN Gyerek Kerékpár', 'bikes'],
      ['ENDURO > Vázak', '2023 COMMENCAL T.E.M.P.O. GLITTERY BLACK Enduro Vázak', undefined],
      ['DOWNHILL > Vázak', '2025 COMMENCAL SUPREME DH V5 Váz', undefined],
      ['ALKATRÉSZEK > E-bike', 'Bosch PowerTube 750 akkumulátor', undefined],
      ['RUHÁZAT > Sisakok', 'Fox Rampage MIPS fullface bukósisak', undefined],
    ])('gates the category %j (title %j) to %s', async (category, name, slug) => {
      expect(await slugOf(config, { category, name, description: newBike, cikkszam: '95224-5' })).toBe(slug);
    });

    // The feed does not flag its used bikes; the shop's own wording for them in
    // the description does, on the rows that have one. Marketing copy that
    // merely mentions use ("használatra", "lelkiállapot") stays in.
    it.each([
      ['ENDURO > Kerékpárok', 'Nagyon szép állapotú enduro minimális használati nyomokkal.', undefined],
      ['E-BIKE', 'Nagyon szép állapotú E-bike minimális használati nyomokkal.\n5310km-t futott a kerékpár', undefined],
      ['ENDURO > Kerékpárok', 'Újszerű Norco szerviz után, minimális használati nyomokkal.', undefined],
      ['ENDURO > Kerékpárok', 'Nagyon szép állapotú enduro kerékpár újszerű állapotban&amp;nbsp;', undefined],
      ['DOWNHILL', 'Eladó rendszeresen karban tartott Santa Cruz Bizományi értékesités', undefined],
      ['ENDURO > Kerékpárok', 'Teljes felfüggesztésű kerékpárjaink évekig tartó kemény használatra tervezték őket.', 'bikes'],
      ['ALL-MOUNTAIN', 'A hardtail motorozás egy igazi lelkiállapot; a lovaglás örömét helyezi a középpontba.', 'bikes'],
      ['E-BIKE', '...', 'ebikes'],
    ])('gates %j with the description %j to %s', async (category, description, slug) => {
      expect(await slugOf(config, { category, description, name: '2026 Test Bike', cikkszam: '425594' })).toBe(slug);
    });

    // Specialized numbers framesets 7xxxx; one sits among the e-bikes titled as
    // a complete bike (S-Works Turbo Levo 4 at half the bike's price).
    it.each([
      ['75224-0', undefined],
      ['70326-0', undefined],
      ['95224-0', 'ebikes'],
    ])('gates an E-BIKE row with cikkszam %j to %s', async (cikkszam, slug) => {
      expect(
        await slugOf(config, { category: 'E-BIKE', name: '2026 Specialized S-Works Turbo Levo 4 Ebike', description: '...', cikkszam }),
      ).toBe(slug);
    });

    // `identifier` (= `code`) is unique on all 7,197 rows; `cikkszam` repeats.
    it('keys offers on identifier', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'identifier' });
    });

    // `cikkszam` holds the maker's article number for Specialized, Scott,
    // Kellys and Commencal (BT…), a 13-digit EAN on a few Kellys and Pells rows,
    // and the shop's own codes for the rest (14–15-digit numbers on Ghost,
    // Lapierre and Norco, invented codes on Santa Cruz, Unno, Amflow, Yeti).
    it.each([
      ['95224-5', '95224-5', undefined],
      ['96526-8220', '96526-8220', undefined],
      ['290558', '290558', undefined],
      ['425080M', '425080', undefined],
      ['76233', '76233', undefined],
      ['BT5RMN20EU220', 'BT5RMN20EU220', undefined],
      ['8585053849773', undefined, '8585053849773'],
      ['54129472835149', undefined, undefined],
      ['111883898062699', undefined, undefined],
      ['27SCB90', undefined, undefined],
      ['23tempoessfb', undefined, undefined],
      ['22METAPWE1', undefined, undefined],
      ['SBIMWCNKP00x', undefined, undefined],
      ['AMF01', undefined, undefined],
    ])('reads cikkszam %j as MPN %j and GTIN %j', async (cikkszam, mpn, gtin) => {
      expect(await readText(config, 'mpn', { cikkszam })).toBe(mpn);
      expect(await readText(config, 'gtin', { cikkszam })).toBe(gtin);
    });

    // StartÜzlet writes `&quot;` (sometimes `\&quot;`) inside CDATA, where no
    // XML parser decodes it.
    it('drops the undecoded inch marks from the title', async () => {
      expect(
        await readText(config, 'name', { name: ' 2023 KELLYS Theos F100 SH L 29\\&quot;/27.5\\&quot; 825Wh Ebike ' }),
      ).toBe('2023 KELLYS Theos F100 SH L 29/27.5 825Wh Ebike');
      expect(await readText(config, 'name', { name: 'COMMENCAL RAMONES 14&quot; PUSH BIKE Green' })).toBe(
        'COMMENCAL RAMONES 14 PUSH BIKE Green',
      );
    });

    // The shop ends every title with its category ("Trail Kerékpár"); the
    // identity extraction kept "Trail" in 3 of 4 models of the test round
    // (Spark 910 Trail, Epic 8 Expert Trail). The discipline words it never kept
    // (Enduro, Downhill, Gravel, Dirt, MTB) stay, and so does a model's own
    // "Trail" (Ghost Riot Trail, Pells Rocket Trail).
    it.each([
      ['2026 SCOTT Spark 910 Trail Kerékpár', '2026 SCOTT Spark 910 Kerékpár'],
      ['2027 Specialized Epic 9 Comp XC Kerékpár', '2027 Specialized Epic 9 Comp Kerékpár'],
      ['2023 KELLYS Thorx 50 M 29&quot; All-mountiain Kerékpár', '2023 KELLYS Thorx 50 M 29 Kerékpár'],
      ['2025 Ghost Riot Trail CF Full Party Enduro Kerékpár', '2025 Ghost Riot Trail CF Full Party Enduro Kerékpár'],
      ['PELLS Rocket Trail 24 Black Kerékpár', 'PELLS Rocket Trail 24 Black Kerékpár'],
      ['2026 COMMENCAL RAMONES 20 BLACK Gyerek Kerékpár', '2026 COMMENCAL RAMONES 20 BLACK Gyerek Kerékpár'],
    ])('reads the title %j as %j', async (name, title) => {
      expect(await readText(config, 'name', { name })).toBe(title);
    });

    // 4 gated rows have an empty `manufacturer`; the importer skips a row
    // without a brand, so the title's first word stands in (the identity
    // extraction's brand wins either way).
    it('falls back to the title for an empty manufacturer', async () => {
      expect(await readText(config, 'brand', { manufacturer: 'Santacruz', name: '2027 Santa Cruz Vala 90 E-bike' })).toBe('Santacruz');
      expect(
        await readText(config, 'brand', { manufacturer: '', name: '2025 COMMENCAL T.E.M.P.O. POWER ESSENTIAL GLITTERY BLACK E-bike' }),
      ).toBe('COMMENCAL');
      expect(await readText(config, 'brand', { manufacturer: '', name: 'LAPIERRE Overvolt AM 7.8 Circular Grey Ebike' })).toBe('LAPIERRE');
    });

    it('blanks the "..." description placeholder', async () => {
      expect(await readText(config, 'description', { description: '...' })).toBeUndefined();
      expect(await readText(config, 'description', { description: newBike })).toBe(newBike);
    });

    // No delivery column: presence in the feed means in stock.
    it('reads presence in the feed as in stock', async () => {
      expect(config.mapping['availability']).toEqual({ field: 'delivery_time', pipeline: IN_STOCK_UNLESS_NO });
      expect(await readText(config, 'availability', {})).toBe('in_stock');
    });

    it('sends the shop category path to the identity extraction', async () => {
      for (const slug of ['ebikes', 'bikes']) {
        expect(await extraRowOf(config, slug, 'Webshop kategória', { category: 'ENDURO > Kerékpárok' })).toBe(
          'ENDURO > Kerékpárok',
        );
      }
    });
  });

  describe("bikecafe's Google Shopping feed config", () => {
    const config = asFeedConfig(bikecafeGoogleshopConfig);
    const stripCurrency = [{ op: 'stripPattern', pattern: '\\s*[A-Z]{3}$' }];
    const schemaKeys: Record<string, Set<string>> = {
      bikes: new Set(Object.keys(bikesJsonSchema.properties)),
      ebikes: new Set(Object.keys(ebikesJsonSchema.properties)),
    };
    // The shop's category membership, as ShopRenter writes it into the custom
    // labels: every category the product sits in, in no particular order.
    const labels = (...values: string[]) =>
      Object.fromEntries(values.map((value, index) => [`custom_label_${index}`, value]));

    it('validates against the feed config schema', () => {
      assertConfigValid(config, 'bikecafe-googleshop', 'googleshop');
    });

    // The test round's id `filter` and its `maxItems` go on the live row only.
    it('carries no test-round filter or cap', () => {
      expect(pick(config, ['filter', 'maxItems'])).toEqual({});
    });

    // The shop's only feed with its own categories and an old price, so it
    // identifies products: both LLM calls run, and no description excerpts
    // (its titles already name the usage type).
    it('leaves both LLM calls on', () => {
      expect(config.postProcess).toBeUndefined();
    });

    // One row per colour × size child; `id` is unique across all 19,863 rows.
    // `mpn` is the manufacturer's article number of that child (KTM's 10 digits,
    // Merida's 7, Stevens' 9), the same id space as the other shops' MPNs.
    it('keys offers on id, and reads gtin and mpn as published', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'id' });
      expect(config.mapping['gtin']).toEqual({ field: 'gtin' });
      expect(config.mapping['mpn']).toEqual({ field: 'mpn' });
      expect(config.mapping['releaseYear']).toBeUndefined();
    });

    it('takes the sale price, else the price, and the price as the old price', () => {
      expect(config.mapping['price']).toEqual([
        { field: 'sale_price', pipeline: stripCurrency },
        { field: 'price', pipeline: stripCurrency },
      ]);
      expect(config.mapping['priceWithoutDiscount']).toEqual({ field: 'price', pipeline: stripCurrency });
    });

    // The feed lists out-of-stock children too (493 of 583 e-bike rows), and
    // Google's values are OfferAvailability's own.
    it('reads stock from the availability column', () => {
      expect(config.mapping['availability']).toEqual({ field: 'availability' });
    });

    // Used bikes are kept out by the gate, not mapped as an offer condition.
    it('maps no condition', () => {
      expect(config.mapping['condition']).toBeUndefined();
    });

    it.each([
      ['E-BIKE > MTB E-Bike > Összteleszkópos MTB E-Bike', labels('MTB E-Bike', 'Összteleszkópos MTB E-Bike', 'E-BIKE'), 'ebikes'],
      ['E-BIKE > Trekking E-Bike > Női trekking E-Bike', labels('Trekking E-Bike', 'Női trekking E-Bike', 'E-BIKE'), 'ebikes'],
      ['KERÉKPÁR > Gravel kerékpár', labels('Gravel kerékpár', 'KERÉKPÁR'), 'bikes'],
      ['KERÉKPÁR > Gyerek kerékpár > 20" kerékpár', labels('Gyerek kerékpár', '20" kerékpár', 'KERÉKPÁR'), 'bikes'],
      // The shop's two used bikes.
      ['KERÉKPÁR > Használt kerékpár', labels('KERÉKPÁR', 'Használt kerékpár'), undefined],
      // A promotion or the Árukereső export category as the main path: the bike's
      // other categories decide, whatever their order.
      [
        'AKCIÓINK > MERIDA készletkisöprés',
        labels('Gravel E-Bike', 'Elektromos kerékpár', 'MERIDA készletkisöprés', 'E-BIKE'),
        'ebikes',
      ],
      ['AKCIÓINK > KTM készletkisöprés', labels('KTM készletkisöprés', 'Országúti E-Bike', 'E-BIKE'), 'ebikes'],
      [
        'AKCIÓINK > MERIDA készletkisöprés',
        labels('Kerékpár', 'Gravel kerékpár', 'MERIDA készletkisöprés', 'KERÉKPÁR'),
        'bikes',
      ],
      ['arukereso > Kerékpár', labels('Országúti kerékpár', 'Kerékpár', 'KERÉKPÁR'), 'bikes'],
      ['arukereso > Kerékpár kitámasztó', labels('Kitámasztó', 'Kerékpár kitámasztó', 'KIEGÉSZÍTŐ'), undefined],
      ['AKCIÓINK > Szuperakció', labels('Szuperakció', 'KIEGÉSZÍTŐ'), undefined],
      // E-bike accessories sit outside the E-BIKE tree.
      ['KIEGÉSZÍTŐ > Lakat, nyomkövető > E-Bike zár', labels('Lakat, nyomkövető', 'E-Bike zár', 'KIEGÉSZÍTŐ'), undefined],
      ['KIEGÉSZÍTŐ > Pumpa > Elektromos pumpa', labels('Biciklipumpa', 'Pumpa', 'Elektromos pumpa', 'KIEGÉSZÍTŐ'), undefined],
      // Only a promotion or export path falls back to the labels: a part stays a
      // part even if the shop also files it among its bikes.
      ['ALKATRÉSZ > Kerék > Külső gumi > MTB külső gumi', labels('Külső gumi', 'KERÉKPÁR'), undefined],
    ])('gates %j with labels %j to %s', async (productType, customLabels, slug) => {
      expect(await slugOf(config, { product_type: productType, title: 'X', ...customLabels })).toBe(slug);
    });

    it.each(['ebikes', 'bikes'] as const)('turns the %s columns into spec rows', async (slug) => {
      const row = {
        product_type: 'KERÉKPÁR > Trekking kerékpár > Női trekking kerékpár',
        size: '46 cm',
        color: 'Zöld',
        material: 'Alumínium',
      };
      expect(await extraRowOf(config, slug, 'Webshop kategória', row)).toBe(row.product_type);
      expect(await extraRowOf(config, slug, 'Méret', row)).toBe('46 cm');
      expect(await extraRowOf(config, slug, 'Szín', row)).toBe('Zöld');
      expect(await extraRowOf(config, slug, 'Váz anyaga', row)).toBe('Alumínium');
    });

    // The size column holds a letter, centimetres or (Stevens MTBs, Merida kids'
    // bikes) inches; only the first two are read. Colour stays as the shop
    // writes it.
    it.each([
      ['ebikes', 'Méret', 'M', 'frameSizeLabel', 'M'],
      ['ebikes', 'Méret', 'XXL', 'frameSizeLabel', 'XXL'],
      ['ebikes', 'Méret', '56 cm', 'frameSize', 56],
      ['ebikes', 'Méret', '56 cm', 'frameSizeLabel', undefined],
      ['ebikes', 'Méret', '18"', 'frameSize', undefined],
      ['bikes', 'Méret', 'XS', 'frameSizeLabel', 'XS'],
      ['bikes', 'Méret', '51 cm', 'frameSize', 51],
      ['bikes', 'Méret', '11.5"', 'frameSize', undefined],
      ['ebikes', 'Szín', 'Mohaszürke', 'color', 'Mohaszürke'],
      ['bikes', 'Szín', 'Smaragd/Viola', 'color', 'Smaragd/Viola'],
      ['ebikes', 'Váz anyaga', 'Karbon', 'frameMaterial', 'Karbon'],
      ['bikes', 'Váz anyaga', 'Alumínium', 'frameMaterial', 'Alumínium'],
    ] as const)('reads a %s row %s: %j as %s %j', (slug, name, value, key, expected) => {
      expect(specsOf(config, slug, { [name]: value })[key]).toEqual(expected);
    });

    it('maps only specs its category has, the same way in both', () => {
      const ebikes = config.categories?.['ebikes']?.specMapping?.mappings ?? [];
      const bikes = config.categories?.['bikes']?.specMapping?.mappings ?? [];
      for (const [slug, mappings] of [['ebikes', ebikes], ['bikes', bikes]] as const) {
        expect(mappings.map((mapping) => mapping.key).filter((key) => !schemaKeys[slug].has(key))).toEqual([]);
      }
      expect(bikes.filter((mapping) => schemaKeys['ebikes'].has(mapping.key))).toEqual(
        ebikes.filter((mapping) => schemaKeys['bikes'].has(mapping.key)),
      );
    });
  });

  describe("k2shop's Árukereső feed config", () => {
    const config = asFeedConfig(k2shopArukeresoConfig);

    it('validates against the Árukereső config schema', () => {
      assertConfigValid(config, 'k2shop-arukereso', 'arukereso');
    });

    // The test round's id filter and cap go on the live row only.
    it('carries no test-round filter or cap', () => {
      expect(pick(config, ['filter', 'maxItems'])).toEqual({});
    });

    // A bike-and-ski shop: the category path's first segment says e-bike or
    // bike; parts, accessories, clothing and ski gear have their own first
    // segment, even where their title says eBike. The demo bike ("teszt
    // kerékpár") and the frame sets ("vázszett") sit among the bikes and are
    // dropped by title. The two sections test different labels, so no row is
    // claimed twice.
    it.each([
      ['Elektromos kerékpárok / eMTB, terepre', 'Scott Strike eRide 930 kerékpár 2021 XL', 'ebikes'],
      ['Elektromos kerékpárok / eTúra, eVárosi', 'KTM Macina Fold kerékpár 2026 20', 'ebikes'],
      ['Elektromos kerékpárok / eJunior', 'Cube Acid 240 Hybrid Rookie Pro 400X Actionteam E-kerékpár 2026', 'ebikes'],
      ['Kerékpárok / MTB', 'Scott Scale 940 29 MTB kerékpár 2021 XL', 'bikes'],
      ['Kerékpárok / Junior, gyerek', 'Kellys Alpina Tornado futóbicikli 2020 12', 'bikes'],
      ['Kerékpárok / Városi', 'Electra Loft 7i Matte Hazel Ladies kerékpár 2019 S', 'bikes'],
      ['Elektromos kerékpárok / eMTB, terepre', 'Scott Patron eRide 910 teszt kerékpár 2022 M', undefined],
      ['Kerékpárok / MTB', 'Bold Linkin 150 29 MTB kerékpár vázszett 2025 L', undefined],
      ['Kerékpárok / Országúti', 'Scott Addict RC Pro HMX vázszett 2025 L', undefined],
      ['Alkatrészek / Nyereg / Nyereg', 'Selle Italia Lady eBike Gel Flow L nyereg', undefined],
      ['Kiegészítők / Computerek, kijelzők / e Bike kijelzők', 'Bosch Kiox 300 (BHU3600) display computer', undefined],
      ['Kiegészítők / Világítás / Világítás', 'Supernova M99 Pro 45 eBike első lámpa', undefined],
      ['Ruházat / Cipők', 'Scott MTB RC Evo Boa kerékpáros cipő 2023 43', undefined],
      ['Sí felszerelés / Sílécek', 'Völkl Junior Racetiger yellow síléc kötéssel 2011 70', undefined],
    ])('gates the category %j (title %j) to %s', async (category, title, slug) => {
      expect(await slugOf(config, { category, name: title })).toBe(slug);
    });

    // `identifier` is unique per row (16,049 of 16,049); the size rows of one
    // bike share its URL.
    it('keys offers on identifier', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'identifier' });
    });

    // Cube's identifiers are its item number plus the size, the form the other
    // shops' Cube MPNs take (akosbike VLB_104020-M, speedbike 104020-M), behind
    // k2shop's model-year prefix and its -27/-29 wheel note. A letter after the
    // item number (L, E) marks k2shop's own frame variant, and no other brand's
    // identifier carries the manufacturer's code with its size, so those give none.
    it.each([
      ['MY26_104020_M', '104020M'],
      ['MY26-117510_L', '117510L'],
      ['MY26_141200-29_XL', '141200XL'],
      ['1140600-29_XL', '1140600XL'],
      ['1140600-27_S', '1140600S'],
      ['532761_50', '53276150'],
      ['MY26_150120_12', '15012012'],
      ['645100L_54', undefined],
      ['1111112E_46', undefined],
      ['1107272', undefined],
      ['SC21280469_XL', undefined],
      ['KTM2612601902_20', undefined],
      ['22704281BLUMAT_S', undefined],
      ['TR525868BLK_M', undefined],
      ['K25182_S', undefined],
    ])('reads the MPN off the identifier %j', async (identifier, mpn) => {
      expect(await readText(config, 'mpn', { identifier })).toBe(mpn);
    });

    // productnumber is the page's "Gyártói cikkszám", but per model, not per
    // size (KTM's 8-digit article base, Scott's 6-digit model number), and for
    // other rows the shop's own code: it matches no other shop's MPN. The feed
    // has no EAN, no old price, and states years only in its titles.
    it('maps no GTIN, old price or year, and not productnumber', () => {
      expect(pick(config.mapping, ['gtin', 'priceWithoutDiscount', 'releaseYear'])).toEqual({});
      expect(JSON.stringify(config.mapping)).not.toMatch(/productnumber/i);
    });

    it('sends the category path to the identity extraction as it stands', async () => {
      for (const slug of ['ebikes', 'bikes']) {
        expect(
          await extraRowOf(config, slug, 'Webshop kategória', { category: 'Kerékpárok / Junior, gyerek' }),
        ).toBe('Kerékpárok / Junior, gyerek');
      }
    });

    // The feed has no spec table, and unification never writes identity specs,
    // so battery and torque reach the identity extraction only as rows. The
    // descriptions name them: the first sentence with a motor and a battery
    // (182 of 225 e-bike rows; never a range extender's Wh alone, which no
    // such sentence names), and the first torque figure (118 rows).
    it.each([
      [
        'Összteleszkópos 29"-es E-bike. Bosch Performance CX 250W motor és 625Wh akkumulátor. Marzocchi Z2 Air villával.',
        'Bosch Performance CX 250W motor és 625Wh akkumulátor',
        undefined,
      ],
      [
        'Sőt, a vázra pluszban felszerelhetsz egy 250 Wh PowerMore kiegészítő akkumulátort. Az elegáns C:62 karbonváz a Bosch SX motorját és egy 400 Wh akkumulátort rejt, amely akár 60 Nm pedálrásegítést kínál.',
        'Az elegáns C:62 karbonváz a Bosch SX motorját és egy 400 Wh akkumulátor',
        '60 Nm',
      ],
      [
        'Macina Trekking 6061 aluminium váz Bosch Performance Line CX BDU3840 - 25km/h / 85Nm motor Bosch Powertube 800wh akkumulátor SR Suntour villa',
        'Macina Trekking 6061 aluminium váz Bosch Performance Line CX BDU3840 - 25km/h / 85Nm motor Bosch Powertube 800wh akkumulátor',
        '85Nm',
      ],
      ['29"-es mountain bike. Shimano Deore váltóval.', undefined, undefined],
    ])('reads the drive rows off the description %j', async (description, drive, torque) => {
      expect(await extraRowOf(config, 'ebikes', 'Motor és akkumulátor', { description })).toBe(drive);
      expect(await extraRowOf(config, 'ebikes', 'Motor nyomatéka', { description })).toBe(torque);
    });

    it('gives bikes no drive rows', () => {
      const labels = (config.categories?.['bikes']?.extraSpecRows ?? []).map((row) => row.label);
      expect(labels).toEqual(['Webshop kategória']);
    });

    // The titles rarely name the bike type (39 of 225 e-bike rows); the
    // descriptions open with it ("Összteleszkópos 29"-es E-bike.", "Cross
    // e-bike kerékpár.").
    it('sends the identity extraction description excerpts', () => {
      expect(config.postProcess?.identityDescription).toEqual({ mode: 'evidence' });
    });
  });

  describe("biciklikk's Árukereső feed config", () => {
    const config = asFeedConfig(biciklikkArukeresoConfig);

    it('validates against the config schema', () => {
      assertConfigValid(config as unknown as ProductSourceConfig, 'biciklikk-arukereso', 'arukereso');
    });

    // E-bikes under `Termékek > E-Bike`, bikes under `Termékek > Kerékpárok`
    // (kids' and balance bikes included); the e-scooter tree holds only parts.
    it.each([
      ['Termékek > E-Bike > Túra, trekking, cross e-kerékpárok > Trekking, túra e-kerékpárok', 'ebikes'],
      ['Termékek > E-Bike > MTB e-kerékpárok', 'ebikes'],
      ['Termékek > E-Bike > Speciális e-bike > Elektromos teherszállító kerékpárok / e-cargo', 'ebikes'],
      ['Termékek > Kerékpárok > MTB kerékpárok', 'bikes'],
      ['Termékek > Kerékpárok > Gyerekkerékpárok', 'bikes'],
      ['Termékek > Kerékpárok > Országúti és fitnesz kerékpárok > Gravel kerékpárok', 'bikes'],
      ['Termékek > E-Roller > E-roller alkatrészek > Xiaomi alkatrészek', undefined],
      ['Termékek > Alkatrészek > Kerék > Külső gumi', undefined],
      ['Termékek > Kiegészítők > Szállítás és tárolás > Kerékpárszállító', undefined],
      ['Szolgáltatások', undefined],
    ])('gates the category %j to %s', async (category, slug) => {
      expect(await slugOf(config, { category, name: 'KELLYS Physio 50 28" fitness kerékpár, M (170-185cm)' })).toBe(slug);
    });

    // The adult trike, the one cosmetically damaged bike, and any used or demo
    // bike stay out of both trees.
    it.each([
      ['Termékek > Kerékpárok > Speciális kerékpárok > Háromkerekű kerékpár, tricikli', 'CSEPEL Camping 3 20" háromkerekű kerékpár / tricikli, 3 seb. agyváltós, kontrás, fehér', undefined],
      ['Termékek > Kerékpárok > MTB kerékpárok', 'GT Aggressor Expert Shimano 2021 29" MTB hardtail kerékpár, Silver, S (esztétikai hibás)', undefined],
      ['Termékek > E-Bike > Városi e-kerékpárok', 'NEUZER Genova 26" női városi elektromos kerékpár, bemutató darab, 17"', undefined],
      ['Termékek > Kerékpárok > Gyerekkerékpárok', 'KELLYS Kite 12" gyermek tanulókerékpár / futóbicikli, Red', 'bikes'],
      ['Termékek > Kerékpárok > Speciális kerékpárok > Tandem kerékpárok', 'CSEPEL Tandem 28" kerékpár', 'bikes'],
    ])('gates %j with the title %j to %s', async (category, name, slug) => {
      expect(await slugOf(config, { category, name })).toBe(slug);
    });

    // `identifier` (the distributor prefix + sku) is unique on all 4,049 rows;
    // `sku` repeats on the shop's "-másolata-1" copies.
    it('keys offers on identifier', () => {
      expect(config.mapping['externalId']).toEqual({ field: 'identifier' });
    });

    // Kellys' and Alpina's sku is the size's EAN-13. ean_code is never read: it
    // holds the shop's own 1xxxxx000000c numbers on every row that fills it.
    it.each([
      ['KLS_8585053831143', '1006940000000', '8585053831143'],
      ['KLS_8585019397096-másolata-1', '', undefined],
      ['KRO_KRTR1Z28X17M002483', '1115420000000', undefined],
      ['NZR_NE2201001014', '', undefined],
    ])('reads the GTIN of identifier %j (ean_code %j) as %j', async (identifier, eanCode, gtin) => {
      expect(await readText(config, 'gtin', { identifier, ean_code: eanCode })).toBe(gtin);
    });

    // The manufacturer's code behind the distributor prefix, for Kross and its
    // Le Grand line, Csepel, Neuzer and Koliken, the codes other shops write too.
    it.each([
      ['KRO_KRTR2Z28X19M002501', 'KRTR2Z28X19M002501'],
      ['KRO_LGLHZ328X19W001447', 'LGLHZ328X19W001447'],
      ['CSP_94400403B2', '94400403B2'],
      ['CSP_93814121OR', '93814121OR'],
      ['NZR_NE2201001014', 'NE2201001014'],
      ['KLK_KP1611B2', 'KP1611B2'],
      // A copy row keeps its original's code under another colour.
      ['NZR_NE2200602034-másolata-1', undefined],
      // Cannondale's ASP_ code is the importer's, and Kellys' sku is an EAN.
      ['ASP_00077549_2_1', undefined],
      ['KLS_8585053831143', undefined],
      ['DEM_B21243', undefined],
    ])('reads the MPN of identifier %j as %j', async (identifier, mpn) => {
      expect(await readText(config, 'mpn', { identifier })).toBe(mpn);
    });

    it.each([
      ['Le Grand Bikes', 'Le Grand'],
      ['Kellys', 'Kellys'],
    ])('reads the brand %j as %j', async (manufacturer, brand) => {
      expect(await readText(config, 'brand', { manufacturer })).toBe(brand);
    });

    it('drops the Árukereső tracking query from the URL', async () => {
      const page = 'https://www.biciklikk.hu/kellys-physio-50-28-fitness-kerekpar-m-170-185cm';
      expect(
        await readText(config, 'url', { product_url: `${page}?utm_source=arukereso&utm_medium=cpp&utm_campaign=direct_link` }),
      ).toBe(page);
    });

    it('sends the category path to the identity extraction', async () => {
      const category = 'Termékek > E-Bike > Városi e-kerékpárok';
      expect(await extraRowOf(config, 'ebikes', 'Webshop kategória', { category })).toBe(category);
      for (const section of Object.values(config.categories ?? {})) {
        expect(section.identitySpecRows).toContain('Webshop kategória');
      }
    });

    // What the shared "category sections" block checks for the other feeds,
    // until this config joins its list.
    it('maps each spec only where its category has it, and the same way in both', () => {
      const keys = {
        bikes: new Set(Object.keys(bikesJsonSchema.properties)),
        ebikes: new Set(Object.keys(ebikesJsonSchema.properties)),
      };
      const ebikes = config.categories?.['ebikes']?.specMapping?.mappings ?? [];
      const bikes = config.categories?.['bikes']?.specMapping?.mappings ?? [];
      expect(ebikes.filter((m) => !keys.ebikes.has(m.key))).toEqual([]);
      expect(bikes.filter((m) => !keys.bikes.has(m.key))).toEqual([]);
      expect(bikes.filter((m) => keys.ebikes.has(m.key))).toEqual(ebikes.filter((m) => keys.bikes.has(m.key)));
    });
  });

  describe("biciklikk's spec rows", () => {
    const config = asFeedConfig(biciklikkArukeresoConfig);

    it.each([
      ['ebikes', 'Akkumulátor', 'Kellys K2 AMXXPRO Carbon 725 Wh - superhigh energy density 213 Wh/kg, weight 3.4 kg', 'batteryCapacity', 725],
      ['ebikes', 'Akkumulátor', 'MXUS 36V 11 Ah (396 Wh)', 'batteryCapacity', 396],
      ['ebikes', 'Akkumulátor', 'Samsung 36V 10,4 Ah (374 Wh), vázba integrált', 'batteryPosition', 'Vázba integrált'],
      ['ebikes', 'Motor', 'Bafang H300, 36V/250W/45Nm', 'torque', 45],
      ['ebikes', 'Motor', 'Bafang H300, 36V/250W/45Nm', 'motorPower', 250],
      ['ebikes', 'Motor', 'MXUS XF06 első agymotor, 250W, 30 Nm', 'motorPosition', 'Első kerékagy motor'],
      ['ebikes', 'Motor', 'Panasonic GXM, max torque 100 Nm', 'motorPosition', 'Középmotor'],
      ['ebikes', 'Rásegítés', '3 fokozatú, kormányról vezérelhető, pedálszenzoros', 'sensorType', 'Fordulatszám-szenzor'],
      ['ebikes', 'Hatótáv', '60-70 km', 'range', 70],
      ['ebikes', 'Kijelző', 'MXUS LED890', 'display', true],
      ['ebikes', 'Hátsó rugóstag', 'Rock Shox Deluxe Select, DebonAir+ / R damper (210x55 mm)', 'suspension', 'Első teleszkóp, hátsó rugóstag'],
      ['bikes', 'Modell év', '2022', 'modelYear', 2022],
      ['bikes', 'Modellév', '2024', 'modelYear', 2024],
      ['bikes', 'Kerék', '27,5"', 'wheelSize', 27.5],
      ['bikes', 'Kerék', "28''", 'wheelSize', 28],
      ['bikes', 'Kerék', '16 col', 'wheelSize', 16],
      // Two wheel sizes in one row give none.
      ['bikes', 'Kerék', '27,5" (XS, S) / 29" (M, L, XL)', 'wheelSize', undefined],
      ['ebikes', 'Kerék', '29"/27.5" (mullet)', 'wheelSize', undefined],
      ['bikes', 'Váltófokozat', '21 (3x7)', 'gearCount', 21],
      ['bikes', 'Váltófokozat', '1x6', 'gearCount', 6],
      ['bikes', 'Váltófokozat', '-', 'gearCount', undefined],
      ['bikes', 'Súly', '11,8 kg', 'weight', 11.8],
      ['bikes', 'Tömeg', '27.5" 13.0 kg | 29" 13.2 kg', 'weight', 13],
      ['bikes', 'Váz anyaga', 'rozsdamentes acél', 'frameMaterial', 'Acél'],
      ['bikes', 'Váz anyaga', 'AL-6061 alumínium ötvözet', 'frameMaterial', 'Alumínium'],
      // Kellys Theos F's carbon-aramid frame, as the shop words it.
      ['ebikes', 'Váz anyaga', 'acél-karbon kompozit', 'frameMaterial', 'Karbon'],
      ['bikes', 'Villa', 'merev acél 28"', 'suspension', 'Rugózatlan'],
      ['bikes', 'Villa', 'SR Suntour M3010 26", 63 mm', 'suspension', 'Első teleszkóp'],
      ['bikes', 'Villa', 'Kross, 80mm', 'suspension', 'Első teleszkóp'],
      ['bikes', 'Villa', 'Kellys Carbon Disc - 1.5 tapered steerer, flat mount disc brake, 12 mm thru axle', 'suspension', 'Rugózatlan'],
      ['bikes', 'Hátsó váltó', 'Shimano Nexus 3 SPD', 'gearType', 'Agyváltó'],
      ['bikes', 'Hátsó váltó', 'Shimano TY300 7 SPD', 'gearType', 'Láncváltó'],
      ['bikes', 'Első váltó', '-', 'frontDerailleur', 'Nincs'],
      ['bikes', 'Első fék', 'Alhonga V-fék', 'brakeType', 'Racker (Felni)'],
      ['bikes', 'Fékek', 'Shimano MT200 Hydraulic Disc', 'brakeType', 'Tárcsa'],
      ['bikes', 'Féktárcsák', '180mm front / 160mm rear', 'rotorSizeFront', 180],
      ['bikes', 'Külső gumik', 'Schwalbe Smart Sam 60-622 (29"x2.35) K-Guard', 'tireSize', '60-622'],
      ['bikes', 'Felszerelés', 'első-hátsó világítás, első-hátsó sárvédő, csomagtartó, kitámasztó', 'rack', 'Alapfelszereltség'],
      ['bikes', 'Felszerelés', 'első-hátsó világítás, első-hátsó sárvédő, csomagtartó, kitámasztó', 'lighting', 'Alapfelszereltség'],
      ['bikes', 'Felszerelés', 'első-hátsó világítás, első-hátsó sárvédő, csomagtartó, kitámasztó', 'kickstand', true],
      ['bikes', 'Felszerelés', 'kitámasztó', 'rack', undefined],
      ['bikes', 'Kiegészítők', 'sárvédő és csomagtartó utólag felszerelhető', 'rack', 'Opcionális'],
      ['bikes', 'Pedálok', 'PEDÁL NÉLKÜL!', 'pedals', undefined],
      ['bikes', 'Ajánlott életkor', '2-4 év között', 'recommendedAge', '2-4 év'],
      ['bikes', 'Ajánlott magasság', '119-135 cm között', 'recommendedRiderHeight', '119-135 cm'],
    ] as const)('reads a %s row %s: %j as %s %j', (slug, name, value, key, expected) => {
      expect(specsOf(config, slug, { [name]: value })[key]).toEqual(expected);
    });

    // Colour and size stay with the title: these rows list every colour and
    // size of the model, not this row's.
    it('maps no colour or size from the list rows', () => {
      const specs = specsOf(config, 'bikes', {
        Szín: 'blue / white, glossy; grey / black matte; black / grey glossy',
        Vázméret: 'S (160-175 cm), M (170-185cm), L (180-195cm)',
        Méretválaszték: '17", 19"',
      });
      expect(pick(specs, ['color', 'frameSize', 'frameSizeLabel'])).toEqual({});
    });
  });
});
