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
    it('leaves both LLM calls on', () => {
      expect(config.postProcess?.identity).not.toBe(false);
      expect(config.postProcess?.specs).not.toBe(false);
    });

    // Only where the measured excerpts added usage types (bikelife's and
    // akosbike's descriptions name them; ambringa's are brand talk, and
    // mangobike's titles already name them): plan vivid-skipping-hopper.md.
    it('sends the identity extraction description excerpts only where they help', () => {
      const evidence = ['akosbike-arukereso', 'bikelife-arukereso'].includes(name);
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
});
