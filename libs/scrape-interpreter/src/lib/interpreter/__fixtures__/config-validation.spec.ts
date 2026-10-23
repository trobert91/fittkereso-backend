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

  describe("ebikeshop's spec rows", () => {
    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    const ebikeshopRows = (rows: Record<string, string>) =>
      specsOf(ebikeshopConfig as unknown as ArukeresoSourceConfig, 'ebikes', rows);

    // display: the shop's "Kijelző típus" row is on every e-bike; a named display is one.
    it.each([
      ['Bosch Kiox 300', true],
      ['Bosch Led Remote', true],
      ['Bosch Purion 200', true],
      ['Nincs', false],
    ])('ebikeshop maps Kijelző típus %j to display %j', (value, display) => {
      expect(ebikeshopRows({ 'Kijelző típus': value })).toMatchObject({ display });
    });

    // usageType: Váztípus names the bike type more precisely than Felhasználás
    // módja ("MTB", "Kompakt városi"), so it wins when it names one.
    it.each([
      ['All Mountain', 'MTB', 'Összteleszkópos MTB'],
      ['Összteleszkópos', 'MTB', 'Összteleszkópos MTB'],
      ['Merev MTB', 'MTB', 'MTB'],
      ['Összecsukható', 'Kompakt városi', 'Összecsukható'],
    ])('ebikeshop maps Váztípus %j (Felhasználás módja %j) to usageType %j', (frame, use, usageType) => {
      expect(ebikeshopRows({ 'Váztípus': frame, 'Felhasználás módja': use })).toMatchObject({ usageType });
    });

    it('ebikeshop keeps Felhasználás módja when Váztípus is a step height', () => {
      expect(ebikeshopRows({ 'Váztípus': 'Alacsony', 'Felhasználás módja': 'Városi' })).toMatchObject({
        usageType: 'City',
        frameType: 'Alacsony',
      });
    });

    // frameType: only the three step heights; a type word is no frame type.
    it.each(['Összecsukható', 'Merev MTB', 'All Mountain', 'Összteleszkópos'])(
      'ebikeshop takes no frameType from Váztípus %j',
      (frame) => {
        expect(ebikeshopRows({ 'Váztípus': frame })).not.toHaveProperty('frameType');
      },
    );

    it('ebikeshop maps Rugózás "Nincs" to Rugózatlan', () => {
      expect(ebikeshopRows({ 'Rugózás': 'Nincs' })).toMatchObject({ suspension: 'Rugózatlan' });
    });

    // ebikeSystem only where the motor row states the system; "Perf. Line CX
    // BDU38" rows say nothing about it and are left to the LLM.
    it.each([
      ['Bosch performance Line CX (Smart System)', 'Bosch Smart System'],
      ['Bosch Performance Line PX (Smart System)', 'Bosch Smart System'],
      ['Bosch Perf. Line CX BDU38', undefined],
    ])('ebikeshop maps Motor típusa %j to ebikeSystem %j', (motor, ebikeSystem) => {
      expect(ebikeshopRows({ 'Motor típusa': motor })['ebikeSystem']).toBe(ebikeSystem);
    });

    // gender: the title's frame code (HE = Herren, US = Unisex) becomes the
    // synthetic "Nem (vázkód)" row (detailPage.rawSpecs appendSyntheticSpec).
    it.each([
      ["MACINA TOUR CX 810 GX AXS HE56cm '26 agyagbarna", 'Férfi'],
      ["Touring Hybrid Deluxe SLX 800 HE50cm '27 szürke", 'Férfi'],
      ["Supreme Hybrid Comfort ONE 600 US42cm '27 viharkék", 'Uniszex'],
      ['RM Homage5 GT rohloff US56 cm kék elektromos kerékpár', 'Uniszex'],
      ["KTM MACINA STYLE 820 TR46cm fehér elektromos kerékpár", undefined],
      ["KTM MACINA SCARP SX EXONICX T-TYPE 48cm '26 narancs", undefined],
    ])("ebikeshop reads the frame code in %j as gender %j", async (title, gender) => {
      const raw = (ebikeshopConfig as unknown as ScrapingSourceConfig).detailPage.rawSpecs as ScrapeOperation[];
      const synthetic = raw.find((op) => op.op === 'appendSyntheticSpec') as unknown as {
        name: string;
        value: ScrapeOperation[];
      };
      expect(synthetic.name).toBe('Nem (vázkód)');
      const row = await interpreter.runValuePipeline(synthetic.value.slice(1), title, {
        baseUrl: 'https://ebikeshop.hu',
      });
      expect(row ?? undefined).toBe(gender);
      if (row) expect(ebikeshopRows({ 'Nem (vázkód)': row as string })).toMatchObject({ gender });
    });

    // An explicit gender word in Váztípus beats the title's frame code, and a
    // step height there no longer blanks the code's gender.
    it('ebikeshop lets Váztípus "Cross női" win over the title code, and keeps the code over a step height', () => {
      expect(ebikeshopRows({ 'Nem (vázkód)': 'Férfi', 'Váztípus': 'Cross női' })).toMatchObject({ gender: 'Női' });
      expect(ebikeshopRows({ 'Nem (vázkód)': 'Férfi', 'Váztípus': 'Magas' })).toMatchObject({
        gender: 'Férfi',
        frameType: 'Magas',
      });
    });
  });

  describe("speedbike's Árukereső feed config", () => {
    const config = speedbikeArukeresoConfig as unknown as ArukeresoSourceConfig;

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // The path segments whose listings all agreed with the LLM's usage type on
    // the 2026-10-23 sample. KERÉKPÁR > TREKKING holds cross-trekking bikes too,
    // CITY - URBAN E-BIKE a folding bike, FITNESS E-BIKE a city bike, and the
    // older "Gravel - Cyclocross" two types: those stay with the LLM.
    it.each([
      ['KERÉKPÁR > MTB > Fully MTB > 29"', 'bikes', 'Összteleszkópos MTB'],
      ['KERÉKPÁR > MTB > Hardtail MTB > 29"', 'bikes', 'MTB'],
      ['KERÉKPÁR > GRAVEL', 'bikes', 'Gravel'],
      ['KERÉKPÁR > CROSS', 'bikes', 'Cross Trekking'],
      ['KERÉKPÁR > ORSZÁGÚTI', 'bikes', 'Országúti'],
      ['KERÉKPÁR > GYEREK KERÉKPÁR > 26" (145cm felett)', 'bikes', 'Gyerek'],
      ['KERÉKPÁR > TREKKING', 'bikes', undefined],
      ['KERÉKPÁR > Gravel - Cyclocross', 'bikes', undefined],
      ['E-BIKE > TREKKING E-BIKE', 'ebikes', 'Trekking'],
      ['E-BIKE > GRAVEL E-BIKE', 'ebikes', 'Gravel'],
      ['E-BIKE > MTB E-BIKE', 'ebikes', 'MTB'],
      ['E-BIKE > ÖSSZTELESZKÓPOS E-BIKE', 'ebikes', 'Összteleszkópos MTB'],
      ['E-BIKE > Cross Trekking E-BIKE', 'ebikes', undefined],
      ['E-BIKE > CITY - URBAN E-BIKE', 'ebikes', undefined],
      ['E-BIKE > FITNESS E-BIKE', 'ebikes', undefined],
    ])('reads the usage type off the path %j (%s) as %j', (path, slug, usageType) => {
      expect(specsOf(config, slug as 'bikes' | 'ebikes', { 'Webshop kategória': path })['usageType']).toBe(usageType);
    });

    // The motor row names the brand first, and its one wattage is the rated
    // power (the LLM put it in motorPeakPower).
    it.each([
      ['Motor', 'Bosch PERFORMANCE PX BDU3470', { motorBrand: 'Bosch' }],
      ['engine', 'Bosch Drive Unit Performance SX (55Nm) Cruise (250 Watt), Smart System', { motorBrand: 'Bosch', motorPower: 250, torque: 55 }],
      ['Motor', 'Bosch Drive Unit Active Line Plus Generation 3 (50Nm) Cruise (250Watt), Smart System', { motorPower: 250, torque: 50 }],
      ['MOTOR', 'Bosch PERFORMANCE CX Gen.4 SMART SYSTEM - 25km/h / 85Nm / 250W', { motorBrand: 'Bosch', motorPower: 250, topSpeed: 25, torque: 85 }],
      ['MOTOR', 'Bosch Perfomance Line 3.GEN., 250W, 65 Nm, 25 km/h', { motorBrand: 'Bosch', motorPower: 250, topSpeed: 25 }],
    ])('reads the %s row %j', (name, value, expected) => {
      expect(specsOf(config, 'ebikes', { [name]: value })).toMatchObject(expected);
    });

    // A wattage marked as the maximum is the peak, not the rated power; Giant's
    // SyncDrive is no brand this mapping names.
    it('reads no rated power or brand off a peak-only Giant motor row', () => {
      const specs = specsOf(config, 'ebikes', { Motor: 'Giant SyncDrive Race, 48v, 90Nm, 700W max power, 400% max support ratio' });
      expect(specs['motorPower']).toBeUndefined();
      expect(specs['motorBrand']).toBeUndefined();
    });

    // The travel, never the axle (15x110, QR15mm, 12x100mm).
    it.each([
      ['Villa', 'SR Suntour XCS, 100mm', 100],
      ['VILLA', 'Suntour NEX tekercs 28" 63mm', 63],
      ['Villa', 'FOX 34SC Float 29" Factory 120mm 15x110', 120],
      ['VILLA', 'SUNTOUR NEX-E25 DS QR 700C STEEL TAPERED / 63mm Travel', 63],
      ['fork', 'SR Suntour NEX-E25, 50mm', 50],
      ['Villa', 'ROCKSHOX JUDY GOLD RL 15mm SOLO AIR 100mm BOOST + ONELOC', 100],
      ['Villa', 'CUBE TS Disc, Full Carbon, Taper, Flat Mount, 12x100mm', undefined],
    ])('reads the fork travel of the %s row %j as %j', (name, value, forkTravel) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { [name]: value })['forkTravel']).toBe(forkTravel);
      }
    });

    // The range as numbers only: the schema's unit "T" is appended on display.
    // A regexpList cannot rewrite "11x34" into the dash form: that stays with the LLM.
    it.each([
      ['Fogaskoszorú', 'Shimano Cues CS-LG300, 11-46T', '11-46'],
      ['FOGASKOSZORÚ', 'Shimano HG31-8 / 11-32', '11-32'],
      ['FOGASKOSZORÚ', 'SRAM XX SL T-Type XS-1299 / 10-52', '10-52'],
      ['cassette', 'Sram XS-1275, 10-52T', '10-52'],
      ['Kazetta', 'Sunrace CSM55 8AV / 11-34T', '11-34'],
      ['Fogaskoszorú', 'Shimano CS-HG400, 11x34', undefined],
      ['Fogaskoszorú', 'SUNRACE CSM66-8', undefined],
    ])('reads the cassette range of the %s row %j as %j', (name, value, cassetteRange) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { [name]: value })['cassetteRange']).toBe(cassetteRange);
      }
    });

    // KTM's "Hajtás" row is the drivetrain (rings × sprockets); Cube's is the
    // crankset, whose "46x30T" is no gear count.
    it.each([
      ['Hajtás', '1X5 SHIMANO NEXUS', { gearCount: 5, chainringCount: 1 }],
      ['Hajtás', '1X12 SHIMANO DEORE XT', { gearCount: 12, chainringCount: 1 }],
      ['Hajtás', '2X12 SHIMANO 105', { gearCount: 24, chainringCount: 2 }],
      ['HAJTÁSRENDSZER', '2X12 SHIMANO GRX', { gearCount: 24, chainringCount: 2 }],
    ])('reads the %s row %j', (name, value, expected) => {
      expect(specsOf(config, 'bikes', { [name]: value })).toMatchObject(expected);
    });

    it('reads no gear count off a crankset in the Hajtás row', () => {
      const specs = specsOf(config, 'bikes', { Hajtás: 'Shimano GRX FC-RX610, 46x30T' });
      expect(specs['gearCount']).toBeUndefined();
      expect(specs['chainringCount']).toBeUndefined();
      expect(specs['chainring']).toBe('46x30T');
    });

    // Several rings from the crank row as written; one ring is chainringTeeth.
    it.each([
      ['HAJTÓMŰ', 'Shimano Tourney T501 48-38-28T', { chainring: '48-38-28T' }],
      ['Hajtókar', 'Shimano GRX FC-RX820, 48x31T', { chainring: '48x31T' }],
      ['HAJTÓMŰ', 'Shimano Claris FC-RS200 50x34T', { chainring: '50x34T' }],
      ['HAJTÓMŰ', 'SRAM XX SL T-Type Carbon DUB 34T', { chainringTeeth: 34 }],
      ['Hajtókar', 'Shimano MT511-12 32T', { chainringTeeth: 32 }],
    ])('reads the crank row %s %j', (name, value, expected) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { [name]: value })).toMatchObject(expected);
      }
    });

    it.each([
      ['Töltő', 'Bosch STANDARD Charger 4A', 4],
      ['TÖLTŐ', 'Bosch Compact 2A Charger', 2],
      ['charger', 'Bosch 4A', 4],
    ])('reads the charger current of the %s row %j as %j', (name, value, chargerCurrent) => {
      expect(specsOf(config, 'ebikes', { [name]: value })['chargerCurrent']).toBe(chargerCurrent);
    });

    it.each([
      ['Első fék', 'Tektro HD-M750 / E730 4-Piston', 4],
      ['Első fék', 'Shimano MT402 (3-F) / MT420 4-Piston', 4],
      ['FÉK', 'TEKTRO 2 dugattyús', 2],
      ['ELSŐ FÉK', 'Tektro HD-T275 2-piston', 2],
      ['Fék', 'Shimano BR-MT200, Hydr. Disc Brake (180/160)', undefined],
    ])('reads the brake pistons of the %s row %j as %j', (name, value, brakePistons) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { [name]: value })['brakePistons']).toBe(brakePistons);
      }
    });

    // Spacing × axle as the schema writes it ("148x12"), from a hub row in
    // either order, or from a wheelset row naming both hubs (Cube: axle first).
    it.each([
      ['Hátsó agy', 'DT Swiss 370 6B 32H 148/12TA', { hubSpacingRear: '148x12' }],
      ['HÁTSÓ AGY', 'Shimano MT400B CL 32H 148-12TA', { hubSpacingRear: '148x12' }],
      ['Hátsó agy', 'Shimano TC500 CL 28H 142-12TA', { hubSpacingRear: '142x12' }],
      ['Hátsó agy', 'Shimano MT400-B Steckachse 12x148mm', { hubSpacingRear: '148x12' }],
      ['ELSŐ AGY', 'Shimano TC500B CL 32H 110-15TA', { hubSpacingFront: '110x15' }],
      ['Első agy', 'Shimano Deore M6000 CL 32H 100-5QR', { hubSpacingFront: '100x5' }],
      ['wheelset', 'Newmen Beskar 30, 28/28 Spokes (Light/Base), 15x110mm / 12x148mm, Tubeless Ready', { hubSpacingFront: '110x15', hubSpacingRear: '148x12' }],
      ['Kerékszett', 'ACID SLX RA 2.3 Aero Disc, 28/28 Spokes, Centerlock, 12x100mm/12x142mm, Tubeless Ready', { hubSpacingFront: '100x12', hubSpacingRear: '142x12' }],
    ])('reads the hub row %s %j', (name, value, expected) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { [name]: value })).toMatchObject(expected);
      }
    });

    it.each([
      ['Nyeregcső', 'bySchulz G.2 ST suspension 30.9/350', 30.9],
      ['seat post', 'Newmen Advanced, Carbon, 27.2mm', 27.2],
      ['NYEREGCSŐ', 'Syncros RR2.5 27.2/350mm', 27.2],
      ['Nyeregcső', 'CUBE Dropper Post, Handlebar Lever, Internal Cable Routing, 31.6mm', 31.6],
      ['Nyeregcső', 'KTM Comp dropper internal', undefined],
    ])('reads the seatpost diameter of the %s row %j as %j', (name, value, seatpostDiameter) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { [name]: value })['seatpostDiameter']).toBe(seatpostDiameter);
      }
    });

    it.each([
      ['Kormány', 'Ergotec low rizer 740mm', 740],
      ['KORMÁNY', 'KTM Team Trail35 rizer25 800mm', 800],
      ['handlebar', 'CUBE Rise Trail Bar, 680mm', 680],
      ['Kormány', 'FSA KFX SIC Carbon 65x780mm', 780],
      ['Kormány', 'Giant Connect XC Riser 31.8x690mm', 690],
      ['Kormány', 'Giant Contour GT, cable integrated, 30° back sweep 31.8mm', undefined],
    ])('reads the handlebar width of the %s row %j as %j', (name, value, handlebarWidth) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { [name]: value })['handlebarWidth']).toBe(handlebarWidth);
      }
    });

    // The shop's own spellings, its "Össszsúly" typo included, and a decimal before "kg".
    it.each([
      ['Össszsúly utassal', '130 kg', { maxTotalWeight: 130 }],
      ['Maximum összsúly', '128 kg', { maxTotalWeight: 128 }],
      ['Maximális megengedett össztömeg', '127,00 kg', { maxTotalWeight: 127 }],
      ['LEGNAGYOBB MEGENGEDETT ÖSSZTÖMEG', '146', { maxTotalWeight: 146 }],
      ['Utas súly MAX', '100 kg', { maxLoad: 100 }],
    ])('reads the weight row %s %j', (name, value, expected) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { [name]: value })).toMatchObject(expected);
      }
    });

    // Component rows under labels the mapping did not know yet.
    it.each([
      ['ebikes', 'wheelset', 'Newmen Evolution SL X.R.25', 'wheelset'],
      ['bikes', 'Kerékszett', 'Newmen Performance X.R.25, 28/28 Spokes, 12x100mm / 12x142mm, Tubeless Ready', 'wheelset'],
      ['bikes', 'ELSŐ  KERÉK', 'KTM Line - Shimano DH-3D37 CL 32H 100 QR / KTM 28" Casual 32H; 622x19 / Richman 2.0 INOX, ezüst', 'wheelset'],
      ['ebikes', 'seat clamp', 'CUBE Screwlock, 36mm', 'seatClamp'],
      ['bikes', 'seat clamp', 'CUBE Screwlock, 31.8mm', 'seatClamp'],
      ['ebikes', 'Akku', 'Bosch CompactTube 400', 'batteryModel'],
      ['bikes', 'Hátsó kerékagy', 'Formula DC-25 8s RQR Disc', 'hubModel'],
      ['ebikes', 'rear hub', 'Shimano Alfine SG-S7001, 8-Speed', 'hubModel'],
      ['bikes', 'BAL VÁLTÓKAR', 'Shimano SL-U4000-9R w/ OGD', 'shifter'],
      ['bikes', 'Váltó/fékkar egység', 'Shimano GRX ST-RX610', 'shifter'],
      ['bikes', 'Váltó/fékkar egység', 'Shimano GRX ST-RX610', 'brakeLever'],
      ['ebikes', 'shift-brake-levers', 'Shimano GRX ST-RX820', 'shifter'],
      ['ebikes', 'shift-brake-levers', 'Shimano GRX ST-RX820', 'brakeLever'],
      ['ebikes', 'FÉKKAR', 'Shimano BR-M200 Disc', 'brakeLever'],
      ['bikes', 'Felni', 'Syncros X-20 Disc 32H / black', 'rimModel'],
      ['ebikes', 'FELNI', 'Cross X17 Disc 32h', 'rimModel'],
      ['bikes', 'FÉKTÁRCSA', 'Shimano CL900 CL 160 freeza / CL900 CL 160 freeza', 'rotorModel'],
      ['ebikes', 'gear teeth', 'Shimano Nexus, 18T', 'cassette'],
      ['bikes', 'Kazetta', 'Sunrace CSM55 8AV / 11-34T', 'cassette'],
      ['ebikes', 'Hátsó teleszkóp', 'Fox Float Rhythm RC, 210x55mm, Adjustable LSR w/ 2-Pos. Lever', 'rearShockModel'],
      ['bikes', 'RUGÓSTAG', 'FOX Float SL Perf-Elite 3PTL 210x55', 'rearShockModel'],
      ['ebikes', 'GUMIKÖPENY', 'Schwalbe Energizer Active Plus 700x50c', 'tireModel'],
      ['bikes', 'HÁTSÓ GUMIKÖPENY', 'Schwalbe G-ONE Bite Performance 700x40C', 'tireModel'],
      ['bikes', 'front derailleur', 'Shimano Cues FD-U6010, Top-Swing, 31.8mm', 'frontDerailleur'],
      ['bikes', 'Küllő', '14 G / stainless / black', 'spokes'],
      ['ebikes', 'Vezérlő', 'Bosch System Control, incl. Mini Remote', 'controlUnit'],
    ])('reads the %s row %j %j as %s', (slug, name, value, key) => {
      expect(specsOf(config, slug as 'bikes' | 'ebikes', { [name]: value })[key]).toBe(value);
    });

    it.each([
      ['ebikes', 'Akku', 'Bosch CompactTube 400', { batteryCapacity: 400 }],
      ['ebikes', 'HÁTSÓ GUMIKÖPENY', 'Maxxis Minion DHR II 3C-MaxxTerra/EXO/TR 70-584', { tireSize: '70-584' }],
      ['bikes', 'FÉKTÁRCSA', 'Shimano CL900 CL 160 freeza / CL900 CL 160 freeza', { rotorSizeFront: 160, rotorSizeRear: 160 }],
      ['bikes', 'Féktárcsa', 'Tektro / 6 bolt / F&R 160mm', { rotorSizeFront: 160, rotorSizeRear: 160 }],
      ['ebikes', 'ROTOR', 'Shimano MT800 CL 203 / EM810 CL 180 Freeza', { rotorSizeFront: 203, rotorSizeRear: 180 }],
      ['ebikes', 'KERÉKMÉRET', '28"', { wheelSize: 28 }],
      ['bikes', 'Kerékméret', '27,5"', { wheelSize: 27.5 }],
    ])('reads the %s row %j %j', (slug, name, value, expected) => {
      expect(specsOf(config, slug as 'bikes' | 'ebikes', { [name]: value })).toMatchObject(expected);
    });

    it('reads no wheel size off a Kerékméret row naming two', () => {
      expect(specsOf(config, 'bikes', { Kerékméret: '29" / 27.5"+' })['wheelSize']).toBeUndefined();
    });

    // A row naming the ABS unit is ABS; a spacer that mentions it is not.
    it.each([
      ['Bosch ABS control unit Magura', true],
      ['BOSCH ABS Pro Control Unit Shimano', true],
      ['-', false],
      ['Spacer ABS PM-Discbrake WT:3mm', undefined],
    ])('reads the ABS row %j as %j', (value, abs) => {
      expect(specsOf(config, 'ebikes', { ABS: value })['abs']).toBe(abs);
    });

    // The year a title ends with; a spec row still wins (it comes first).
    it.each([
      ['Cube Aim ONE  salmon´n´black L  MTB kerékpár - 2027', '2027'],
      ['CUBE KATHMANDU PRO GREY´N´LUNAR - 2025 - TREKKING KERÉKPÁR - 46 CM', '2025'],
      ['Cube AMS Hybrid ONE44 C:62 Pro 400X - Elektromos összteleszkópos MTB kerékpár - blackline színben - L - 2026', '2026'],
      ['KTM MACINA TEAM 892 LFC ABS  M/43 elektromos  MTB kerékpár BURNT ORANGE színben 2026', '2026'],
      ['SCOTT CONTESSA ACTIVE 50 29" PETROL GREEN/MINERAL BLUE M/44CM NŐI MTB KERÉKPÁR', undefined],
    ])('reads the model year of the title %j as %j', async (name, year) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        const row = await extraRowOf(config, slug, 'Modellév (cím)', { name });
        expect(row).toBe(year);
        if (row) expect(specsOf(config, slug, { 'Modellév (cím)': row })['modelYear']).toBe(Number(year));
      }
    });

    it('prefers a Modellév row to the title year', () => {
      expect(specsOf(config, 'bikes', { Modellév: '2024', 'Modellév (cím)': '2027' })['modelYear']).toBe(2024);
    });

    // A rider the title states; a kids' bike for boys is a kids' bike.
    it.each([
      ['KTM X-LIFE TRACK STREET AZZURRO SILVER (DARK GREY+GREY) S/46CM FÉRFI CROSS KERÉKPÁR', 'Férfi'],
      ['SCOTT CONTESSA ACTIVE 50 29" PETROL GREEN/MINERAL BLUE M/44CM NŐI MTB KERÉKPÁR', 'Női'],
      ['KTM MACINA CROSS CX 820 L  D 46 Női elektromos crosstrekking kerékpár FLAMING GREY színben 2026', 'Női'],
      ['PELLS Thorr City Steel Grey M (167-180 cm) 2024 Unisex Elektromos Trekking Kerékpár', 'Uniszex'],
      ['GIANT ARX 20 férfi gyermek cross/gravel kerékpár - 20" méretben', 'Gyermek'],
      ['KTM KTM WILD SPEED 26 méretben -  gyermek kerékpár - METALLIC BLACK+BLUE színben - 2027', 'Gyermek'],
      ['Cube Aim SLX  slateblack´n´chrome M  MTB kerékpár - 2027', undefined],
    ])('reads the rider stated in the title %j as %j', async (name, gender) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        const row = await extraRowOf(config, slug, 'Nem (cím)', { name });
        expect(row).toBe(gender);
        if (row) expect(specsOf(config, slug, { 'Nem (cím)': row })['gender']).toBe(gender);
      }
    });


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

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // The Árukereső feed has no stock or condition column: this source is the
    // only one that states them. Google writes availability in the importer's
    // own spelling, and condition's "New" is read case-insensitively.
    it('reads availability and condition from their columns', async () => {
      expect(config.mapping['availability']).toEqual({ field: 'availability' });
      expect(config.mapping['condition']).toEqual({ field: 'condition' });
      expect(await readText(config, 'availability', { availability: 'out_of_stock' })).toBe('out_of_stock');
      expect(await readText(config, 'condition', { condition: 'New' })).toBe('New');
    });

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

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    /** Every extra row of a section for one feed row, as the importer hands them to specMapping. */
    async function feedSpecsOf(slug: 'bikes' | 'ebikes', fields: Record<string, string>) {
      const rows: Record<string, string> = {};
      for (const { label } of config.categories?.[slug]?.extraSpecRows ?? []) {
        const value = await extraRowOf(config, slug, label, fields);
        if (value) rows[label] = value;
      }
      return specsOf(config, slug, rows);
    }

    // Lower-case words in the titles; "ffi" is the shop's short form. Kids'
    // titles name the child, never the sex.
    it.each([
      ['bikes', 'KTM Life Ride női trekking kerékpár 24 fokozatú ALTUS váltó, tárcsafék, matt elderberry 46cm', 'Női'],
      ['bikes', 'KTM X-Life 1964 Cross férfi cross kerékpár 30 fokozatú Deore XT váltó hidraulikus tárcsafék fekete 46cm', 'Férfi'],
      ['bikes', 'Neuzer X200 Disc ffi cross kerékpár 24sebességes Shimano váltó, fekete/kék-sárga 19"', 'Férfi'],
      ['bikes', 'Kellys Vanity X40 White női specifikus 26" MTB kerékpár Microshift váltórendszerrel és mechanikus tárcsafékekkel 15"/XS', 'Női'],
      ['bikes', 'Kellys Emma Menthol 16"-os gyerekkerékpár kontrafék, alu váz', 'Gyermek'],
      ['bikes', 'Kellys Naga Air Belt yellow 20"-os superlight gyerekkerékpár aluminium vázzal két fokozatú automata agyváltóval és szíjhajtással', 'Gyermek'],
      ['bikes', 'Csepel Mustang 20" fiú gyermek kerékpár, 6 fokozatú váltó, 2023 fekete', 'Gyermek'],
      ['ebikes', 'Scott Sub Tour Eride 30 unisex trekking Ebike 9 fokozatú Shimano Alivio váltó, Bosch meghajtás, M', 'Uniszex'],
      ['ebikes', 'Kellys Tygon R50 Forest férfi 29" MTB Ebike 10 fokozatú Shimano váltó, Panasonic meghajtás, M', 'Férfi'],
      ['ebikes', 'Kellys Estima COMP 60 City Ebike 8 fokozatú Nexus váltó, Shimano Steps meghajtás, S', undefined],
    ] as const)('reads the %s rider from %j as %j', async (slug, name, gender) => {
      expect((await feedSpecsOf(slug, { name }))['gender']).toBe(gender);
    });

    // Only the unambiguous words. A plain "MTB" stays with the LLM (a fully's
    // title may not say so), and "cross" is also a model name (X-Life Cross,
    // Macina Cross). A kids', folding or tandem bike is that whatever else the
    // title says, and the title word overrides the sku prefix.
    it.each([
      ['ebikes', 'Scott Sub Tour Eride 30 unisex trekking Ebike 9 fokozatú Shimano Alivio váltó, Bosch meghajtás, M', '', 'Trekking'],
      ['ebikes', 'Kellys Estima COMP 60 City Ebike 8 fokozatú Nexus váltó, Shimano Steps meghajtás, S', '', 'City'],
      ['ebikes', 'KTM Macina Kapoho Master férfi 29/27,5" összteleszkópos MTB Ebike 12 fokozatú Shimano XT váltó, Bosch Perf. CX Smart meghajtás, L/48cm', '', 'Összteleszkópos MTB'],
      ['ebikes', 'KTM Macina Fold 20 elektromos camping kerékpár Bosch Perf. PX Smart 75Nm/500Wh, Nexus 5 váltó, Gates szíjhatjás,  összecsukható, olive pearl', '', 'Összecsukható'],
      ['ebikes', 'Kellys Tygon R50 Forest férfi 29" MTB Ebike 10 fokozatú Shimano váltó, Panasonic meghajtás, M', '', undefined],
      ['ebikes', 'KTM Macina Cross CX820 ebike 10 fokozatú Shimano CUES U600 Suntour NCX32 Air Flaming Gray 56cm', '', undefined],
      ['bikes', 'Csepel Camping 20"-os városi kerékpár, összecsukható, kontrás, piros', '010900000001', 'Összecsukható'],
      ['bikes', 'Kellys SOOT 20 gravel kerékpár 2x8 fokozartú Shimano Claris váltó, M', '010700000075', 'Gravel'],
      ['bikes', 'Kellys SOOT 30 országúti gravel kerékpár 16 fokozatú Shimano Claris váltó, mechanikus tárcsafék kék L', '010800000054', 'Gravel'],
      ['bikes', 'Csepel Woodlands Zero 24-es gyerek kerékpár alumínium vázzal, 6sebességes, matt zöld', '010600001235', 'Gyerek'],
      ['bikes', 'Csepel Royal 3* singlespeed 28" kerékpár flipflop aggyal, férfi 52cm sárga', '010900000001', 'Single speed / Fixi'],
      ['bikes', 'Scott Spark 960 29" trail kerékpár 1x12 Deore-XT váltóval, 130/120mm rugóúttal, fekete, S', '012000000258', undefined],
    ] as const)('reads the %s type from %j (sku %j) as %j', async (slug, name, sku, usageType) => {
      expect((await feedSpecsOf(slug, { name, sku }))['usageType']).toBe(usageType);
    });

    it('reads a full-suspension title as front and rear suspension', async () => {
      const name =
        'KTM Macina Kapoho Master férfi 29/27,5" összteleszkópos MTB Ebike 12 fokozatú Shimano XT váltó, Bosch Perf. CX Smart meghajtás, L/48cm';
      expect(await feedSpecsOf('ebikes', { name })).toMatchObject({ suspension: 'Első teleszkóp, hátsó rugóstag' });
    });

    // "NN fokozatú", "NN fok.", "NNf", "NN sebességes" and the typos; NxM is
    // chainrings × sprockets, as the bikes schema counts.
    it.each([
      ['bikes', 'KTM Life Ride női trekking kerékpár 24 fokozatú ALTUS váltó, tárcsafék, matt elderberry 46cm', 24],
      ['bikes', 'Scott Contessa Active 40 29" női mtb 18f Shimano Altus váltó Suntour XCT30 100mm rugóút lila M', 18],
      ['bikes', 'KTM Life Space női trekking kerékpár 2x9 fokozatú CUES váltó, tárcsafék, zöld/lila mono váz 46cm', 18],
      ['bikes', 'Kellys SOOT 20 gravel kerékpár 2x8 fokozartú Shimano Claris váltó, M', 16],
      ['bikes', 'Scott Spark 960 29" trail kerékpár 1x12 Deore-XT váltóval, 130/120mm rugóúttal, fekete, S', 12],
      ['bikes', 'Kellys Naga Air 50 24"-os kerékpár 1x7 Shimano TY300', 7],
      ['bikes', 'Neuzer Duster Hobby 27,5"-os MTB kerékpár 21 fokazatú Shimano TY300 váltó, fekete/piros-szürke, 19"', 21],
      ['bikes', 'Kellys Naga Air Belt yellow 20"-os superlight gyerekkerékpár aluminium vázzal két fokozatú automata agyváltóval és szíjhajtással', undefined],
      ['ebikes', 'Kellys Estima COMP 60 City Ebike 8 fokozatú Nexus váltó, Shimano Steps meghajtás, S', 8],
      ['ebikes', 'Kellys Tygon R50 Forest férfi 29" MTB Ebike 10 fokozatú Shimano váltó, Panasonic meghajtás, M', 10],
      ['ebikes', 'Scott Patron eRide 920 elektromos MTB kerékpár Bosch Perf. CX hajtás, 12 fok. Deore XT váltó, 47cm, L', 12],
      ['ebikes', 'Neuzer E-Trek ebike/pedelec aluvázas férfi 6seb, 28"-as kerék, 36V/250W motor, 11Ah Li-ion akku, fekete 19"', 6],
    ] as const)('reads the %s gear count from %j as %j', async (slug, name, gearCount) => {
      expect((await feedSpecsOf(slug, { name }))['gearCount']).toBe(gearCount);
    });

    // The capacity, torque and motor maker the e-bike titles state. "Shimano"
    // names the motor only next to Steps, a torque or "motor"/"meghajtás":
    // the titles also name Shimano derailleurs.
    it.each([
      [
        'KTM Macina Aera FS Elite LFC Ebike Bosch Performance CX 120Nm/800Wh rendszer karbon monovázas 11 fokozatú Cues váltó olive pearl matt 46cm',
        { batteryCapacity: 800, torque: 120, motorBrand: 'Bosch' },
      ],
      [
        'Kellys E-Carson 30 Magic Blue Ebike trekking 95Nm-es Panasonic motor 725Wh akku 9 fokozatú Shimano Cues váltó M',
        { batteryCapacity: 725, torque: 95, motorBrand: 'Panasonic' },
      ],
      [
        'Kellys E-Carson 30 trekking ebike antracit 95Nm-es Panasonic motorral 725 Wh akkuval férfi XL-es',
        { batteryCapacity: 725, torque: 95, motorBrand: 'Panasonic' },
      ],
      [
        'Kellys E-Carson 10 Teal ebike Shimano Steps meghajtás 630Wh akkumulátor Shimano Cues váltórendszer L-es',
        { batteryCapacity: 630, motorBrand: 'Shimano' },
      ],
      ['Kellys E-Cristy 30 White női trekking Ebike 9 fokozatú Altus váltó, Steps meghajtás, L', { motorBrand: 'Shimano' }],
      ['Kellys Tygon R50 Forest férfi 29" MTB Ebike 10 fokozatú Shimano váltó, Panasonic meghajtás, M', { motorBrand: 'Panasonic' }],
      [
        'Neuzer Sorrento női elektromos kerékpár XOFO hátsó agymotoros, 40Nm/324Wh matt fekete 17"',
        { batteryCapacity: 324, torque: 40, motorBrand: 'XOFO' },
      ],
    ])('reads the motor facts of %j', async (name, expected) => {
      expect(await feedSpecsOf('ebikes', { name })).toMatchObject(expected);
    });

    it('reads no motor maker from a Shimano derailleur, and no capacity from "White"', async () => {
      const specs = await feedSpecsOf('ebikes', {
        name: 'KTM Macina Cross CX820 ebike 10 fokozatú Shimano CUES U600 Suntour NCX32 Air Flaming Gray 56cm',
      });
      expect(pick(specs, ['motorBrand', 'batteryCapacity'])).toEqual({});
      expect(
        (await feedSpecsOf('ebikes', { name: 'Kellys Tayen R50 White női 27,5" MTB Ebike 10 fokozatú Shimano váltó, Panasonic meghajtás, M' }))[
          'batteryCapacity'
        ],
      ).toBeUndefined();
    });

    // Titles name no brake combinations; "fék nélküli" (a balance bike) has no
    // enum value and stays empty.
    it.each([
      ['KTM Life Ride női trekking kerékpár 24 fokozatú ALTUS váltó, tárcsafék, matt elderberry 46cm', 'Tárcsa'],
      ['Kellys Spider 50 Black 29"-os MTB kerékpár 3x8 fokozatú Shimano Altus váltó, Hidr. DISC, M', 'Tárcsa'],
      ['Kellys Emma Pink 16"-os gyerekkerékpár kontrafék, alu váz', 'Kontrafék'],
      ['Hauser Puma 12"-os gyerekkerékpár, kontrás, matt szürke', 'Kontrafék'],
      ['Kellys Wasper Neo Teal szuperkönnyű 16-os gyerekkerékpár aluvázzal és V-fékekkel', 'Racker (Felni)'],
      ['Kellys KIRU Purple futóbicikli Alu/Mg váz, csapágyazott fém kerekű, tömlős, fék nélküli', undefined],
    ])('reads the brake of %j as %j', async (name, brakeType) => {
      expect((await feedSpecsOf('bikes', { name }))['brakeType']).toBe(brakeType);
    });

    // Only a material next to "váz": "acélszürke" is a colour, and the ARC's
    // carbon is its fork.
    it.each([
      ['bikes', 'Kellys Emma Menthol 16"-os gyerekkerékpár kontrafék, alu váz', 'Alumínium'],
      ['bikes', 'Kellys Wasper Neo Teal szuperkönnyű 16-os gyerekkerékpár aluvázzal és V-fékekkel', 'Alumínium'],
      ['bikes', 'Kellys Naga Air Belt yellow 20"-os superlight gyerekkerékpár aluminium vázzal két fokozatú automata agyváltóval és szíjhajtással', 'Alumínium'],
      ['bikes', 'Kellys KIRU Purple futóbicikli Alu/Mg váz, csapágyazott fém kerekű, tömlős, fék nélküli', 'Alumínium'],
      ['bikes', 'Kellys ARC 10 Yellow országúti kerékpár 16 fokozatú Claris váltó, alu váz+karbon villa M', 'Alumínium'],
      ['bikes', 'KTM Life Joy férfi trekking kerékpár 24 fokozatú Shimano Altus váltó, acélszürke 56cm', undefined],
      ['ebikes', 'Neuzer Ebike e-Trek LIDO női fekete 7seb. acél váz + teleszkóp 28" 36V/250W 13 Ah Li-ion akku, 19,5"', 'Acél'],
      ['ebikes', 'KTM Macina Aera FS Elite LFC Ebike Bosch Performance CX 120Nm/800Wh rendszer karbon monovázas 11 fokozatú Cues váltó olive pearl matt 46cm', 'Karbon'],
    ] as const)('reads the %s frame material of %j as %j', async (slug, name, frameMaterial) => {
      expect((await feedSpecsOf(slug, { name }))['frameMaterial']).toBe(frameMaterial);
    });

    // A wheel size, never the frame's inch size: a wheel is "NN"-os/-as/-es",
    // "NN" MTB" or "NN" kerék", or a 27.5/28/29 in inches. A mullet stays empty.
    it.each([
      ['bikes', 'Kellys Emma Menthol 16"-os gyerekkerékpár kontrafék, alu váz', 16],
      ['bikes', 'Neuzer 12-es gyerek kerékpár fiú sárga-fekete-kék', 12],
      ['bikes', 'KTM Chicago 27,5"-os MTB kerékpár 18 fokozatú Altus váltó, hidr. tárcsafék, matt szürke XL/53cm', 27.5],
      ['bikes', 'Kellys Vanity 50 Sky Blue női 29"-os MTB kerékpár 24 fok. Shimano Altus váltó, Hidraulikus Disc, 19"/L', 29],
      ['bikes', 'Csepel Traction 200 férfi trekking kerékpár, alumínium váz, 21 fokozatú, matt szürke-kék, 19"', undefined],
      ['bikes', 'KTM Ultra Evo Dim 29" / 27,5" Plus -os MTB kerékpár Sram SX 1x12 azzuro ezüst M/43cm', undefined],
      ['ebikes', 'Kellys Tygon R50 Forest férfi 29" MTB Ebike 10 fokozatú Shimano váltó, Panasonic meghajtás, M', 29],
      ['ebikes', 'Neuzer E-Trek ebike/pedelec aluvázas férfi 6seb, 28"-as kerék, 36V/250W motor, 11Ah Li-ion akku, fekete 19"', 28],
      ['ebikes', 'KTM Macina Kapoho Master férfi 29/27,5" összteleszkópos MTB Ebike 12 fokozatú Shimano XT váltó, Bosch Perf. CX Smart meghajtás, L/48cm', undefined],
    ] as const)('reads the %s wheel of %j as %j', async (slug, name, wheelSize) => {
      expect((await feedSpecsOf(slug, { name }))['wheelSize']).toBe(wheelSize);
    });

    // The Shimano group the title names, as "Shimano <group>"; model codes
    // (TY300) and hub gears stay with the LLM, and "Comp XT" is a model name.
    it.each([
      ['bikes', 'KTM Life Ride női trekking kerékpár 24 fokozatú ALTUS váltó, tárcsafék, matt elderberry 46cm', 'Shimano Altus'],
      ['bikes', 'KTM Ultra 1964 Comp XT 29"-os MTB kerékpár 12 fokozatú Deore XT váltó, mattfekete, S/38cm', 'Shimano Deore XT'],
      ['bikes', 'Scott Spark 960 29" trail kerékpár 1x12 Deore-XT váltóval, 130/120mm rugóúttal, fekete, S', 'Shimano Deore XT'],
      ['bikes', 'Kellys SOOT 20 gravel kerékpár 2x8 fokozartú Shimano Claris váltó, M', 'Shimano Claris'],
      ['bikes', 'Kellys Spider X70 Thunderstorm Blue 29"-os MTB kerékpár 9 fokozatú Shimano Cues váltó, hidr. tárcsafék, M', 'Shimano CUES'],
      ['bikes', 'Kellys Naga Air 50 24"-os kerékpár 1x7 Shimano TY300', undefined],
      ['ebikes', 'Kellys Theos F90 férfi 29/27,5" összteleszkópos MTB Ebike 11 fokozatú Shimano XT Di2 váltó, Shimano Steps meghajtás, M', 'Shimano Deore XT Di2'],
      ['ebikes', 'Scott Patron eRide 920 elektromos MTB kerékpár Bosch Perf. CX hajtás, 12 fok. Deore XT váltó, 47cm, L', 'Shimano Deore XT'],
    ] as const)('reads the %s derailleur group of %j as %j', async (slug, name, rearDerailleurTier) => {
      expect((await feedSpecsOf(slug, { name }))['rearDerailleurTier']).toBe(rearDerailleurTier);
    });

    // A colour in the title is the LLM's, as the shop writes it: no row reads it.
    it('maps no colour from the title', async () => {
      const name = 'KTM Macina Style 810 elektromos kerékpár Bosch CX Smart 100Nm, 800Wh, 11 fokozatú Deore XT váltó, férfi, purple flip 56cm';
      const specs = await feedSpecsOf('ebikes', { name });
      expect(specs['color']).toBeUndefined();
      expect(specs).toMatchObject({ batteryCapacity: 800, torque: 100, gearCount: 11, gender: 'Férfi', motorBrand: 'Bosch' });
    });


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

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // Scott's 6-digit model number (the 9-digit article less its size code: the
    // form the other shops store, so an MPN lookup matches) and Kellys' 5-digit one, as
    // the image folder (= the page's "Cikkszám:") carries them. Scott's 13-digit
    // codes are no GTINs and stay out, as do Cube's two-size codes (VB-…-M-L):
    // the one Cube form the other shops share has a single size.
    it.each([
      ['SC-290674008', '290674'],
      ['SC-290130008', '290130'],
      ['KL-64367', '64367'],
      ['KL-81846', '81846'],
      ['SC-4253288356010', undefined],
      ['VB-125500-M-L', undefined],
    ])('reads the MPN off the image folder %j (review 2026-10-23)', async (sku, mpn) => {
      expect(await readText(config, 'mpn', { image_url: imageOf(sku) })).toBe(mpn);
    });

    // The page's component table: its labels end in a colon.
    it.each([
      ['bikes', { 'Lánc:': 'KMC X12' }, { chain: 'KMC X12', drivetrain: 'Lánc' }],
      ['ebikes', { 'Lánc:': 'Gates drive-belt 118T CDX' }, { chain: 'Gates drive-belt 118T CDX', drivetrain: 'Szíj' }],
      ['bikes', { 'Villa:': 'FOX 34 Float Rhythm Air Grip, 3-Modes' }, { forkModel: 'FOX 34 Float Rhythm Air Grip, 3-Modes', forkType: 'Levegős' }],
      ['ebikes', { 'Villa:': 'SR Suntour NVX 32 5TA NLO Coil, Tapered, 5x100 TA, Lock Out, 100mm Travel' }, { forkType: 'Acélrugós' }],
      ['bikes', { 'Villa:': 'CUBE CSL Race Disc, Full Carbon, 1 1/8" - 1 1/4" Tapered, Flat Mount, 12x100mm' }, { forkType: 'Merev' }],
      ['bikes', { 'Hátsó váltó típusa:': 'Shimano 105', 'Hátsó váltó:': 'Shimano 105 RD-R7100-DGS, 12-Speed' }, { gearType: 'Láncváltó', rearDerailleurTier: 'Shimano 105', rearDerailleur: 'Shimano 105 RD-R7100-DGS, 12-Speed', shiftingActuation: 'Mechanikus' }],
      ['bikes', { 'Hátsó váltó:': 'Shimano Acera M3020-8 SGS' }, { gearType: 'Láncváltó' }],
      ['ebikes', { 'Hátsó váltó típusa:': 'Shimano Nexus 5', 'Hátsó váltó:': 'Shimano Nexus SL-C7000-5, Revoshift' }, { gearType: 'Agyváltó', shiftingActuation: 'Mechanikus' }],
      ['ebikes', { 'Hátsó váltó típusa:': 'Enviolo' }, { gearType: 'Agyváltó' }],
      ['ebikes', { 'Hátsó váltó:': 'SRAM X0 Eagle AXS Transmission 12 Speed, Wireless Electronic Shift System' }, { shiftingActuation: 'Elektromos' }],
      ['ebikes', { 'Hátsó váltó:': 'Shimano Deore Di2 M6260-11 LG SGS shad+' }, { shiftingActuation: 'Elektromos' }],
      ['bikes', { 'Váltókar:': 'SRAM AXS Pod Controller' }, { shifter: 'SRAM AXS Pod Controller', shiftingActuation: 'Elektromos' }],
      ['bikes', { 'Első váltó:': 'Shimano 105 FD-R7100-F, Braze-On' }, { frontDerailleur: 'Shimano 105 FD-R7100-F, Braze-On' }],
      ['ebikes', { 'Hajtómű:': 'Miranda 172,5mm' }, { crankset: 'Miranda 172,5mm', crankLength: 172.5 }],
      ['ebikes', { 'Hajtómű:': 'KTM E-TRAIL2 ISIS 160mm Q12; FSA steel 36T Direct Mount' }, { crankLength: 160, chainring: 'FSA steel 36T Direct Mount', chainringTeeth: 36 }],
      ['bikes', { 'Hajtómű:': 'Prowheel CC10Y-NW, 32T, 170mm' }, { crankLength: 170, chainringTeeth: 32 }],
      ['bikes', { 'Hajtómű:': 'Shimano FC-U6010 / 46-32T w/ BB (BSA) w/ CG' }, { chainGuard: true }],
      ['bikes', { 'Fogaskoszorú:': 'Shimano 105 CS-HG710, 11-36T' }, { cassette: 'Shimano 105 CS-HG710, 11-36T', cassetteRange: '11-36T' }],
      ['ebikes', { 'Fogaskoszorú:': 'Gates Rear Sprocket CDC, 24T' }, { cassette: 'Gates Rear Sprocket CDC, 24T' }],
      ['bikes', { 'Középcsapágy:': 'Shimano BB71-41B pressfit' }, { bottomBracket: 'Shimano BB71-41B pressfit' }],
      ['ebikes', { 'Pedál:': 'Syncros SP-828' }, { pedals: 'Syncros SP-828' }],
      ['ebikes', { 'Fék:': 'SRAM Maven Silver Stealth 4-Piston Disc' }, { brakeModel: 'SRAM Maven Silver Stealth 4-Piston Disc', brakePistons: 4 }],
      ['bikes', { 'Fék:': 'Shimano BR-R7170, Hydr. Disc Brake, Flat Mount (160/160)' }, { brakeModel: 'Shimano BR-R7170, Hydr. Disc Brake, Flat Mount (160/160)' }],
      ['ebikes', { 'Féktárcsa:': 'Disc Brake (203/180)' }, { rotorSizeFront: 203, rotorSizeRear: 180 }],
      ['ebikes', { 'Féktárcsa:': 'Magura MDR-P CL 203; Magura MDR-P CL 180' }, { rotorModel: 'Magura MDR-P CL 203; Magura MDR-P CL 180', rotorSizeFront: 203, rotorSizeRear: 180 }],
      ['bikes', { 'Féktárcsa:': 'Shimano RT10 CL 160 / 160' }, { rotorSizeFront: 160, rotorSizeRear: 160 }],
      ['ebikes', { 'Féktárcsa:': 'Shimano RT30 CL 180; Shimano EM300 CL 160 magnet' }, { rotorSizeFront: 180, rotorSizeRear: 160 }],
      ['bikes', { 'Kerék:': 'ACID Pro 25, 32/32 Spokes, QR/QR, Tubeless Ready' }, { wheelset: 'ACID Pro 25, 32/32 Spokes, QR/QR, Tubeless Ready', tubeless: true }],
      ['ebikes', { 'Felni:': 'ACID EX25, 32H, Disc, Tubeless Ready' }, { rimModel: 'ACID EX25, 32H, Disc, Tubeless Ready', tubeless: true }],
      ['ebikes', { 'Kerékagy:': 'DT Swiss 370 CL 28H 110/15TA; DT Swiss 370 CL 28H 148/12TA' }, { hubModel: 'DT Swiss 370 CL 28H 110/15TA; DT Swiss 370 CL 28H 148/12TA', hubType: 'CenterLock' }],
      ['ebikes', { 'Kerékagy:': 'DT Swiss 370 6B 32H 110/15TA / DT Swiss 370 6B 32H 148/12TA' }, { hubType: '6-lyukas (IS)' }],
      ['bikes', { 'Külsőgumi:': 'Conti Grand Prix, Kevlar, 30-622' }, { tireModel: 'Conti Grand Prix, Kevlar, 30-622', tireSize: '30-622' }],
      ['ebikes', { 'Kormány:': 'Syncros UC3.0 680mm / Rise 12mm / backsweep 15°' }, { handlebar: 'Syncros UC3.0 680mm / Rise 12mm / backsweep 15°', handlebarWidth: 680 }],
      ['ebikes', { 'Kormány:': 'Newmen Advanced Gravel Bar 318, Carbon, 31.8mm' }, { handlebarMaterial: 'Karbon' }],
      ['ebikes', { 'Kormányszár:': 'CUBE Comfort Stem Pro, 35mm, Adjustable' }, { stem: 'CUBE Comfort Stem Pro, 35mm, Adjustable', adjustableStem: true }],
      ['bikes', { 'Kormánycsapágy:': 'Acros AICR intern 1.1/8"-1.5" angle lim' }, { headset: 'Acros AICR intern 1.1/8"-1.5" angle lim' }],
      ['bikes', { 'Markolat:': 'ACID Travel Comfort' }, { grips: 'ACID Travel Comfort' }],
      ['ebikes', { 'Nyereg:': 'Syncros Capilano' }, { saddle: 'Syncros Capilano' }],
      ['ebikes', { 'Nyeregcső:': 'KTM COMP II dropper internal 34.9 T:150' }, { seatpost: 'KTM COMP II dropper internal 34.9 T:150', seatpostType: 'Teleszkópos (dropper)', seatpostDiameter: 34.9 }],
      ['bikes', { 'Nyeregcső:': 'KTM Comp 27.2/300/350/400' }, { seatpostDiameter: 27.2 }],
      ['bikes', { 'Váz:': '28" Alloy 6061 OFFROAD / T-2380-M' }, { frameModel: '28" Alloy 6061 OFFROAD / T-2380-M' }],
      ['ebikes', { 'Hátsó rugóstag:': 'Fox Float Rhythm RC, 210x55mm, Adjustable LSR w/ 2-Pos. Lever' }, { rearShockModel: 'Fox Float Rhythm RC, 210x55mm, Adjustable LSR w/ 2-Pos. Lever', suspension: 'Első teleszkóp, hátsó rugóstag' }],
      ['ebikes', { 'Lámpák:': 'Lezyne Hecto 70LUX 210LUMEN Superbright' }, { lighting: 'Alapfelszereltség' }],
      ['ebikes', { 'Sárvédő:': 'Curana alloy profile Fender' }, { fenders: 'Alapfelszereltség' }],
      ['ebikes', { 'Csomagtartó:': 'Racktime w/ spring clamp SnapIt 2.0' }, { rack: 'Alapfelszereltség' }],
      ['bikes', { 'Letámasztó:': 'KTM 28" adjustable' }, { kickstand: true }],
      ['ebikes', { 'Kijelző:': 'Bosch Kiox 300' }, { displayModel: 'Bosch Kiox 300', display: true }],
      ['ebikes', { 'Motor típusa:': 'Bosch Performance Line CX (85 Nm)' }, { motorBrand: 'Bosch', torque: 85 }],
      ['ebikes', { 'Motor:': 'Bosch Drive Unit Performance Line 75Nm (BDU34)' }, { motorBrand: 'Bosch', torque: 75 }],
      ['ebikes', { 'Motor típusa:': 'Panasonic GX Ultimate' }, { motorBrand: 'Panasonic' }],
      ['ebikes', { 'Akkumulátor töltő:': 'Bosch STANDARD Charger 4A' }, { chargerCurrent: 4 }],
      ['bikes', { 'Váz anyaga:': 'Magnézium' }, { frameMaterial: 'Magnézium' }],
    ] as const)('reads the %s page rows %j (review 2026-10-23)', (slug, rows, specs) => {
      expect(specsOf(config, slug, rows)).toMatchObject(specs);
    });

    // A row that does not state the spec leaves it to the LLM.
    it.each([
      ['bikes', { 'Villa:': 'SR Suntour NEX 63mm' }, 'forkType'],
      ['ebikes', { 'Féktárcsa:': 'Disc Brake (180/180)' }, 'rotorModel'],
      ['ebikes', { 'Fék:': 'Shimano GRX BR-RX820' }, 'brakePistons'],
      ['ebikes', { 'Hátsó váltó típusa:': 'Enviolo', 'Hátsó váltó:': 'Enviolo MC-TWIST' }, 'rearDerailleur'],
      ['ebikes', { 'Hátsó váltó típusa:': 'Shimano Nexus 5' }, 'rearDerailleurTier'],
      ['ebikes', { 'Akkumulátor töltő:': 'PowerTube 625Wh' }, 'chargerCurrent'],
      ['ebikes', { 'Akkumulátor töltő:': 'PowerTube 625Wh' }, 'chargerModel'],
      ['bikes', { 'Hajtómű:': 'Shimano Tourney T501 46-30T' }, 'chainringTeeth'],
      ['bikes', { 'Fogaskoszorú:': 'Shimano 105 R7101-12 / 11-34' }, 'cassetteRange'],
      // A rear-travel row alone is not read: Cube's Nature and Supreme hardtails carry a stray one.
      ['bikes', { 'Hátsó rugós tag útja:': '160 mm' }, 'suspension'],
      ['bikes', { 'Hátsó rugós tag útja:': '160 mm' }, 'rearTravel'],
      // The shop's colour word would replace the title's verbatim maker colour.
      ['ebikes', { 'Szín:': 'szürke' }, 'color'],
    ] as const)('maps no %s value from %j for %s (review 2026-10-23)', (slug, rows, key) => {
      expect(specsOf(config, slug, rows)[key]).toBeUndefined();
    });

    // Inch frame sizes in centimetres; a centimetre size is read as it stands.
    it.each([
      ['ebikes', '19 coll', 48.26],
      ['ebikes', '14,5 coll', 36.83],
      ['bikes', '17,5 coll', 44.45],
      ['bikes', '22 coll', 55.88],
      ['bikes', '57 cm', 57],
    ] as const)('reads the %s frame size %j as %d cm (review 2026-10-23)', (slug, size, cm) => {
      expect(specsOf(config, slug, { 'Vázméret:': size })).toMatchObject({ frameSize: cm });
    });

    // The category path's leaf, where it names the type (the identity outputs agreed on all
    // 28 measured listings but two Cube Nature cross-trekking bikes the LLM called fullies).
    it.each([
      ['bikes', 'Kerékpárok > Túra Kerékpárok > Offroad Cross Trekking Kerékpár', { usageType: 'Cross Trekking' }],
      ['bikes', 'Kerékpárok > Túra Kerékpárok > Onroad Trekking Kerékpár', { usageType: 'Trekking' }],
      ['bikes', 'Kerékpárok > Mountain Bike Kerékpárok > Fully Mountain Bike Kerékpár', { usageType: 'Összteleszkópos MTB', suspension: 'Első teleszkóp, hátsó rugóstag' }],
      ['bikes', 'Kerékpárok > Mountain Bike Kerékpárok > Hardtail Mountain Bike Kerékpár', { usageType: 'MTB', suspension: 'Első teleszkóp' }],
      ['bikes', 'Kerékpárok > Országúti és Gravel Kerékpárok > Országúti Kerékpár', { usageType: 'Országúti' }],
      ['bikes', 'Kerékpárok > Országúti és Gravel Kerékpárok > Gravel Kerékpár', { usageType: 'Gravel' }],
      ['bikes', 'Kerékpárok > Gyerek Kerékpárok > Gyerek Kerékpár', { usageType: 'Gyerek' }],
      ['bikes', 'Kerékpárok > Gyerek Kerékpárok > Gyerek Futóbicikli', { usageType: 'Futóbicikli' }],
      ['ebikes', 'Kerékpárok > Összecsukható Kerékpárok', { usageType: 'Összecsukható' }],
      ['ebikes', 'Elektromos Kerékpárok > Elektromos Túra Kerékpárok > Elektromos Onroad Trekking Kerékpár', { usageType: 'Trekking' }],
      ['ebikes', 'Elektromos Kerékpárok > Elektromos Mountain Bike Kerékpárok > Elektromos Hardtail Mountain Bike Kerékpár', { usageType: 'MTB', suspension: 'Első teleszkóp' }],
      ['ebikes', 'Elektromos Kerékpárok > Elektomos Light Kerékpárok > Elektromos Light Fully Mountain Bike Kerékpár', { usageType: 'Összteleszkópos MTB', suspension: 'Első teleszkóp, hátsó rugóstag' }],
      ['ebikes', 'Elektromos Kerékpárok > Elektromos Országúti Kerékpárok > Elektromos Gravel Kerékpár', { usageType: 'Gravel' }],
      ['ebikes', 'Elektromos Kerékpárok > Elektromos Városi Kerékpárok', { usageType: 'City' }],
    ] as const)('reads the %s category path %j (review 2026-10-23)', (slug, path, specs) => {
      expect(specsOf(config, slug, { 'Webshop kategória': path })).toMatchObject(specs);
    });

    // A leaf whose listings mix types (a Light Túra e-bike titled "Light Hardtail MTB") stays with the LLM.
    it('reads no type from the Light Túra leaf (review 2026-10-23)', () => {
      expect(
        specsOf(config, 'ebikes', { 'Webshop kategória': 'Elektromos Kerékpárok > Elektomos Light Kerékpárok > Elektromos Light Túra Kerékpárok' })
          ['usageType'],
      ).toBeUndefined();
    });

    // Kellys pages have no torque on the motor row; the description's "motor: …, NN Nm, NN V" run has it.
    it('reads torque and voltage from the description motor run (review 2026-10-23)', async () => {
      const description =
        'váz: KELLYS TYGON R-series - advanced robotic welded Al 6061-T6, 12x148 mm Boost thru axle,motor: PANASONIC GX Ultimate, 95 Nm, 36 V,akkumulátor: KELLYS Re-Charge V10 Li-ion internal removable 820 Wh';
      const row = await extraRowOf(config, 'ebikes', 'Motor (leírás)', { description });
      expect(row).toBe('PANASONIC GX Ultimate, 95 Nm, 36 V');
      expect(specsOf(config, 'ebikes', { 'Motor (leírás)': row ?? '', 'Motor típusa:': 'Panasonic GX Ultimate' })).toMatchObject({
        torque: 95,
        batteryVoltage: 36,
        motorBrand: 'Panasonic',
      });
      // The motor row's own figure wins over the description's.
      expect(specsOf(config, 'ebikes', { 'Motor (leírás)': 'Bosch CX, 85 Nm', 'Motor típusa:': 'Bosch Performance Line CX (90 Nm)' })).toMatchObject({ torque: 90 });
      expect(await extraRowOf(config, 'ebikes', 'Motor (leírás)', { description: 'NAPKÖZBEN IS VELED VAN. A KTM motoros rásegítéssel 85 Nm nyomatékot ad.' })).toBeUndefined();
    });

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

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // A 9-digit Scott article-and-size number sits in ean_code on some rows.
    it.each([
      ['293361058', 'scott-293361-XL58', undefined],
      ['4257038116006', 'scott-425703-colorado-gold-S', '4257038116006'],
      ['12345678', '', '12345678'],
    ])('keeps only a GTIN-shaped ean_code %j (sku %j) as %j', async (eanCode, sku, gtin) => {
      expect(await readText(config, 'gtin', { ean_code: eanCode, sku })).toBe(gtin);
    });

    // Scott's 6-digit article number, the one other shops store (290127 = Spark 930).
    it.each([
      ['scott-290127-S', '290127'],
      ['scott-423161-carbon-black-M', '423161'],
      ['scott-286465-054', '286465'],
      ['scott-290670', '290670'],
      ['scott-2863807-S', undefined],
    ])('reads the Scott MPN from sku %j as %j', async (sku, mpn) => {
      expect(await readText(config, 'mpn', { sku })).toBe(mpn);
    });

    // The path's last segment; e-bikes' "Unisex" contradicts the title on 2 of 3 rows, so it is left out.
    it.each([
      ['E-BIKE > E-TÚRA > Férfi', 'Férfi'],
      ['Kerékpár > E-Bike kerékpárok > női', 'Női'],
      ['Kerékpár > Mountain Bike > Mountain Bike 27,5 > női', 'Női'],
      ['Kerékpár > Fixi-1 sebi > Férfi fixi-1 sebi', 'Férfi'],
      ['Kerékpár > Gyerek Kerékpár > Gyerek kerékpár 16', 'Gyermek'],
      ['Kerékpár > Gyerek Kerékpár > Futókerékpár', 'Gyermek'],
      ['Kerékpár > E-Bike kerékpárok > gyerek', 'Gyermek'],
      ['E-BIKE > E-MTB FULLY > Unisex', undefined],
    ])('reads the gender of the path %j as %j, for bikes and e-bikes', (path, gender) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { 'Webshop kategória': path })['gender']).toBe(gender);
      }
    });

    it.each([
      ['KTM Macina Team 893 2025 férfi E-bike Gr. Purple Flip Matt(Grey+Blk) L', 'férfi'],
      ['GHOST E-Square Trekking Essential Ladies női E-Bike Dust/Sand Grey S (155-170 cm)', 'női'],
      ['Bergamont E-Horizon SUV 6 Amsterdam unisex E-bike matt gloomy green 44cm', 'unisex'],
      ['Rock Machine Thunder 29 VB 15 Gyerek Kerékpár', 'Gyerek'],
      ['Neuzer Beach Női Cruiser Kerékpár krém', 'Női'],
      ['Cross Legend Gent férfiTrekking Kerékpár szürkéskék (szürke/bézs) 48cm', undefined],
    ])('reads the gender word of the title %j as %j', async (name, word) => {
      for (const slug of ['bikes', 'ebikes']) {
        expect(await extraRowOf(config, slug, 'Nem (cím)', { name })).toBe(word);
      }
    });

    // The title states the rider for the product; the path is a navigation bucket.
    it.each([
      ['E-BIKE > E-MTB > Unisex', 'férfi', 'Férfi'],
      ['E-BIKE > E-MTB FULLY > Unisex', 'unisex', 'Uniszex'],
      ['Kerékpár > Mountain bike 26 V - fékes > férfi', 'Gyerek', 'Gyermek'],
      ['Kerékpár > Trekking kerékpár > női', 'Női', 'Női'],
    ])('lets the title word decide the gender over the path %j (title %j: %j)', (path, word, gender) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { 'Webshop kategória': path, 'Nem (cím)': word })['gender']).toBe(gender);
      }
    });

    // Only paths that hold one riding type (E-TÚRA mixes trekking, SUV, gravel and city;
    // Classic - Cruiser and Mountain Bike 29 Carbon mix too; the gender-less MTB paths hold kids' bikes).
    it.each([
      ['Kerékpár > Mountain Bike > Mountain Bike 29 Fully > férfi', 'Összteleszkópos MTB'],
      ['Kerékpár > Mountain Bike > Mountain Bike 27,5 Fully > női', 'Összteleszkópos MTB'],
      ['E-BIKE > E-MTB FULLY > Unisex', 'Összteleszkópos MTB'],
      ['Kerékpár > Mountain Bike > Mountain Bike 29 > férfi', 'MTB'],
      ['Kerékpár > Mountain Bike > Mountain bike 26 V - fékes > női', 'MTB'],
      ['E-BIKE > E-MTB > Férfi', 'MTB'],
      ['E-BIKE > E-CROSS > Női', 'Cross Trekking'],
      ['E-BIKE > E-VÁROSI > Unisex', 'City'],
      ['E-BIKE > E-FAT', 'Fat'],
      ['E-BIKE > E-CARGO', 'Cargo'],
      ['Kerékpár > Gravel kerékpár > női', 'Gravel'],
      ['Kerékpár > Trekking kerékpár > férfi', 'Trekking'],
      ['Kerékpár > Cross kerékpár > férfi', 'Cross Trekking'],
      ['Kerékpár > Cyclocross kerékpár > férfi', 'Cyclocross'],
      ['Kerékpár > City Kerékpár > City agyváltós > női', 'City'],
      ['Kerékpár > Fitness kerékpárok > férfi', 'Fitness'],
      ['Kerékpár > Országúti kerékpár > férfi', 'Országúti'],
      ['Kerékpár > Dirt jump kerékpár', 'Dirt'],
      ['Kerékpár > BMX kerékpárok - 20', 'BMX'],
      ['Kerékpár > Fatbike kerékpárok', 'Fat'],
      ['Kerékpár > Fixi-1 sebi > Férfi fixi-1 sebi', 'Single speed / Fixi'],
      ['Kerékpár > Speciális Kerékpárok > Összecsukható kerékpár', 'Összecsukható'],
      ['Kerékpár > Speciális Kerékpárok > Tandem kerékpár', 'Tandem'],
      ['Kerékpár > Gyerek Kerékpár > Futókerékpár', 'Futóbicikli'],
      ['Kerékpár > Gyerek Kerékpár > Gyerek kerékpár 20', 'Gyerek'],
      ['Kerékpár > E-Bike kerékpárok > gyerek', 'Gyerek'],
      ['E-BIKE > E-TÚRA > Férfi', undefined],
      ['Kerékpár > Classic - Cruiser > női', undefined],
      ['Kerékpár > Mountain Bike > Mountain Bike 29 Carbon', undefined],
      ['Kerékpár > Mountain Bike > Mountain Bike 27,5', undefined],
      ['Kerékpár > E-Bike kerékpárok > férfi', undefined],
      ['Akció > Kerékpárok', undefined],
    ])('reads the usage type of the path %j as %j, for bikes and e-bikes', (path, usageType) => {
      for (const slug of ['bikes', 'ebikes'] as const) {
        expect(specsOf(config, slug, { 'Webshop kategória': path })['usageType']).toBe(usageType);
      }
    });

    it.each([
      // Fork travel from the fork row; an axle (15x110), an offset or a steerer is no travel.
      ['ebikes', 'villa', 'SR SUNTOUR NVX30 NLO (29), 100mm, coil spring', 'forkTravel', 100],
      ['ebikes', 'FORK', 'FOX 34 Float 29" AWL e-bike 120mm 15x110', 'forkTravel', 120],
      ['bikes', 'Teleszkóp', 'Suntour XCT30-HLO   100 mm utas', 'forkTravel', 100],
      ['bikes', 'Villa', 'RockShox Domain Gold Isolator R, Travel: 170mm, 15 x 110mm pevná osa Boost', 'forkTravel', 170],
      ['bikes', 'Villa', 'Topstone Carbon, 1-1/8" to 1.5" steerer, 55mm OutFront offset, flat mount disc', 'forkTravel', undefined],
      ['bikes', 'Teleszkóp', 'SR Suntour Zeron 36X Air 140 STR Tapered 44mm fork off set 29x2.6" max WHS', 'forkTravel', undefined],
      ['bikes', 'Villa', 'CrMo kúpos villalábak, 28 mm-es eltolás', 'forkTravel', undefined],
      ['bikes', 'Teleszkóp', 'Rock Shox Judy TK Coil 100 LO', 'forkModel', 'Rock Shox Judy TK Coil 100 LO'],
      // Brake pistons.
      ['ebikes', 'BRAKE', 'Shimano MT402 (3-F) / MT420 4-Piston', 'brakePistons', 4],
      ['ebikes', 'Brakes', 'SRAM Maven Silver Stealth 4-Piston Disc', 'brakePistons', 4],
      ['bikes', 'Fék', 'Tektro HD-T280 (Hydraulic disc brake, 2 pistons)', 'brakePistons', 2],
      ['bikes', 'Fék', 'Shimano MT200 Hydraulic Disc', 'brakePistons', undefined],
      // Cassette range, in the stored "11-36T" form: only where the shop writes the T.
      ['ebikes', 'kazettás fogaskoszorú', 'SHIMANO CS-HG201-9 (11-36T) or microSHIFT Marvo CS-H092 (11-36T)', 'cassetteRange', '11-36T'],
      ['ebikes', 'Cassette', 'Shimano CS-LG40010 11-48 T', 'cassetteRange', undefined],
      ['ebikes', 'SPROCKET', 'Shimano Deore M6100-12 / 10-51', 'cassetteRange', undefined],
      ['bikes', 'Fogaskeréksor', 'Shimano CS-HG200-9 / 11-36T', 'cassetteRange', '11-36T'],
      ['bikes', 'Fogaskeréksor', 'Shimano CS-HG200-9 / 11-36T', 'cassette', 'Shimano CS-HG200-9 / 11-36T'],
      // Handlebar width: the first 3-digit mm figure, when it is a width.
      ['ebikes', 'kormány', 'KALLOY RiseBar - diam 31.8mm / width 640mm', 'handlebarWidth', 640],
      ['ebikes', 'BAR', 'KTM TEAM II flat 2X 720mm', 'handlebarWidth', 720],
      ['ebikes', 'Handlebar', 'Syncros UC3.0 680mm, Rise 12mm, Backsweep 15°', 'handlebarWidth', 680],
      ['bikes', 'Kormány', 'Gravel Bar RA120A 440 mm (S) 460 mm (M) 480 mm (L) 500 mm (XL)', 'handlebarWidth', undefined],
      // Seatpost diameter.
      ['ebikes', 'nyeregcső', 'KLS Active - diam 30.9mm / length 350mm', 'seatpostDiameter', 30.9],
      ['ebikes', 'SEATPOST', 'KTM COMP dropper internal 30.9 T:100', 'seatpostDiameter', 30.9],
      ['ebikes', 'Seatpost', 'Syncros 3.0, 31.6mm, 350mm', 'seatpostDiameter', 31.6],
      ['bikes', 'Nyeregcső', 'Csepel WAK, alu 27,2x400 mm', 'seatpostDiameter', 27.2],
      // Tyre size (ETRTO) and the wheel size its bead names.
      ['ebikes', 'TIRE F', 'Maxxis Rekon EXO/TR 62-622', 'tireSize', '62-622'],
      ['ebikes', 'Front Tire', 'Schwalbe Big Apple Performance, 60-622', 'tireSize', '60-622'],
      ['ebikes', 'köpenyek', 'SCHWALBE Nobby Nic Performance 60-622 (29x2.35) ADDIX', 'tireSize', '60-622'],
      ['ebikes', 'köpenyek', 'SCHWALBE Nobby Nic Performance 60-622 (29x2.35) ADDIX', 'tireModel', 'SCHWALBE Nobby Nic Performance 60-622 (29x2.35) ADDIX'],
      ['bikes', 'köpenyek', 'RUBENA Walrus 47-305 (16x1.75x2)', 'tireModel', 'RUBENA Walrus 47-305 (16x1.75x2)'],
      ['ebikes', 'TIRE F', 'Schwalbe Johnny Watts Perf. Folding 65-584 DD', 'wheelSize', 27.5],
      ['ebikes', 'Front Tire', 'Schwalbe PRO ONE EVO Super RaceTL-EasyFold700x38C', 'wheelSize', 28],
      ['bikes', 'köpenyek', 'RUBENA Walrus 47-305 (16x1.75x2)', 'wheelSize', 16],
      ['ebikes', 'TIRE F', 'Schwalbe Marathon Mondial Perf. RaceGuard 47-622 Reflex', 'wheelSize', undefined],
      // Lighting, from the front or the rear lamp row.
      ['ebikes', 'első lámpa', 'AXA Compactline 35', 'lighting', 'Alapfelszereltség'],
      ['ebikes', 'hátsó lámpa', 'TRELOCK Duo Flat', 'lighting', 'Alapfelszereltség'],
      ['ebikes', 'LIGHT R', 'B&M Toplight 2C', 'lighting', 'Alapfelszereltség'],
      ['bikes', 'LIGHT R', 'AXA Juno Steady', 'lighting', 'Alapfelszereltség'],
      // The accessories row names the rack, the kickstand, the fenders and the lights.
      ['ebikes', 'kiegészitők', 'alloy carrier, adjustable kickstand, bell', 'rack', 'Alapfelszereltség'],
      ['ebikes', 'kiegészitők', 'alloy carrier, adjustable kickstand, bell', 'kickstand', true],
      ['ebikes', 'kiegészitők', 'kickstand, bell', 'rack', undefined],
      ['bikes', 'Kiegészítők', 'Csomagtartó, sárvédő, kitámasztó, csengő', 'fenders', 'Alapfelszereltség'],
      ['bikes', 'Extras', 'fender mount, water bottle cages, tubeless prepared, 38mm max tire size', 'fenders', undefined],
      ['bikes', 'Extras', 'Kickstand mount', 'kickstand', undefined],
      ['bikes', 'Extras', 'Axa Compactline 35E front light, Axa Blueline rear light, Tubus rear rack (25kg)', 'lighting', 'Alapfelszereltség'],
      // Rotor sizes from the combined rows; a size-only cell is no rotor model.
      ['ebikes', 'féktárcsák', '160mm front / 160mm rear', 'rotorSizeFront', 160],
      ['ebikes', 'féktárcsák', '180 mm front / 160 mm rear', 'rotorSizeRear', 160],
      ['ebikes', 'féktárcsák', '160mm front / 160mm rear', 'rotorModel', undefined],
      ['ebikes', 'féktárcsák', 'SM-RT30', 'rotorModel', 'SM-RT30'],
      ['ebikes', 'BRAKE-DISC', 'Shimano RT64 CL 180 / RT64 CL 160', 'rotorSizeRear', 160],
      ['ebikes', 'Rotor', 'Front: SM-RT30 CL 180mm, Rear: SM-RT30 CL 160mm', 'rotorSizeRear', 160],
      ['bikes', 'Féktárcsa Hátsó', 'Shimano RT10 160 mm', 'rotorSizeRear', 160],
      // Hub spacing, in the width x axle form whatever the shop's order.
      ['ebikes', 'Rear Hub', 'Shimano FHTC500HMBB, 148x12mm', 'hubSpacingRear', '148x12'],
      ['ebikes', 'Rear Hub', 'Formula CL-148S, 12x148mm', 'hubSpacingRear', '148x12'],
      ['bikes', 'Hub (Rear)', 'Shimano FH-MT410-B CL / 12x148mm / Micro Spline', 'hubSpacingRear', '148x12'],
      ['ebikes', 'rögzített tengely', 'ROCK SHOX Maxle Stealth 15x110mm front / NOVATEC 12x148mm rear', 'hubSpacingFront', '110x15'],
      ['ebikes', 'WHEEL F', 'KTM Line - DT Swiss 370 6b 32L 110/15 / Ryde Andra29 32H 622x29C', 'hubSpacingFront', '110x15'],
      ['ebikes', 'WHEELSET', 'KTM Line - Shimano Deore M6000 CL 32H 100-5QR / 135 QR', 'hubSpacingRear', undefined],
      // Crank length and chainring teeth from the crankset row; a double or triple has no single ring.
      ['ebikes', 'hajtómű', 'SHIMANO E5000 (38T) - length 175mm', 'crankLength', 175],
      ['ebikes', 'hajtómű', 'SHIMANO E5000 (38T) - length 175mm', 'chainringTeeth', 38],
      ['ebikes', 'CRANKSET', 'KTM E-TEAM2 ISIS 170mm Q8', 'crankLength', 170],
      ['bikes', 'Hajtómű', 'Shimano FC-M315 48/38/28T 175mm', 'chainringTeeth', undefined],
      ['bikes', 'Hajtómű', 'Shimano FC-M315 48/38/28T 175mm', 'crankLength', 175],
      // E-bike electrics.
      ['ebikes', 'Drive Unit', 'Bosch Performance Line PX (BDU347Y)EU: 25kmh', 'topSpeed', 25],
      ['ebikes', 'Drive Unit', 'TQ HPR50 Mid Motor drive 50Nm max Torque / EU: 25kmh / US: 20mph', 'topSpeed', 25],
      ['ebikes', 'motor', 'SHIMANO STEPS E5000, 36 V', 'batteryVoltage', 36],
      ['ebikes', 'Charger', 'TQ 100-240V-4A', 'chargerCurrent', 4],
      ['ebikes', 'CHARGER', 'Bosch Standard Charger 4A', 'chargerCurrent', 4],
      ['ebikes', 'switch unit', 'PANASONIC', 'controlUnit', 'PANASONIC'],
      // Weight: the KG cell of the brand spreadsheets is date-mangled on some rows.
      ['ebikes', 'Approx weight in KG', '28.szept', 'weight', undefined],
      ['ebikes', 'Approx weight in KG', '04.dec', 'weight', undefined],
      ['ebikes', 'Approx weight in KG', '28,9', 'weight', 28.9],
      ['ebikes', 'Approx weight in KG', '19.8 Tubless setup without RE (1.1kg)', 'weight', 19.8],
      ['bikes', 'Kb. súly KG', '10.26', 'weight', 10.26],
      // Labels other rows already had under another spelling.
      ['bikes', 'monoblokk', 'SHIMANO BB-RS500', 'bottomBracket', 'SHIMANO BB-RS500'],
      ['bikes', 'F. DERAILL.', 'Shimano Tourney TY601', 'frontDerailleur', 'Shimano Tourney TY601'],
      ['bikes', 'F.DERAILL', 'Shimano Cues FD-U4000 TS', 'frontDerailleur', 'Shimano Cues FD-U4000 TS'],
      ['bikes', 'Ülés', 'Syncros Savona 2.5 V-Concept', 'saddle', 'Syncros Savona 2.5 V-Concept'],
      ['ebikes', 'fűzott kerekek', 'NOVATEC M30A 622x30 front / NOVATEC M35A 584x35 rear, Center Lock', 'wheelset', 'NOVATEC M30A 622x30 front / NOVATEC M35A 584x35 rear, Center Lock'],
    ] as const)('reads a %s row %s: %j as %s %j (review 2026-10-23)', (slug, name, value, key, expected) => {
      expect(specsOf(config, slug, { [name]: value })[key]).toEqual(expected);
    });

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

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // The shop's own path names the type where a segment holds one type only. "Fitness, városi",
    // "Cross, Trekking", "Cross-trekking" (Kathmandu trekking next to Nature cross), "Országúti" (a
    // Cross Race cyclocross among the road bikes) and the 12"/14"/balance-bike path mix types: the LLM decides.
    it.each([
      ['ebikes', 'Elektromos kerékpárok > Új E-bike Kerékpár > MTB Fully E-bike kerékpár', 'Összteleszkópos MTB'],
      ['ebikes', 'Elektromos kerékpárok > Új E-bike Kerékpár > Gravel E-bike kerékpár', 'Gravel'],
      ['ebikes', 'Elektromos kerékpárok > Új E-bike Kerékpár > Gyerek E-bike kerékpár', 'Gyerek'],
      ['ebikes', 'Elektromos kerékpárok > Új E-bike Kerékpár > Fitness, városi E-bike kerékpár', undefined],
      ['ebikes', 'Elektromos kerékpárok > Új E-bike Kerékpár > Cross, Trekking E-bike kerékpár', undefined],
      ['bikes', 'Cube kerékpárok > MTB kerékpár', 'MTB'],
      ['bikes', 'Cube kerékpárok > MTB fully kerékpár', 'Összteleszkópos MTB'],
      ['bikes', 'Cube kerékpárok > Gravel kerékpár', 'Gravel'],
      ['bikes', 'Cube kerékpárok > 20" gyerek kerékpár', 'Gyerek'],
      ['bikes', 'Cube kerékpárok > 12", 14" és futó gyerek kerékpár', undefined],
      ['bikes', 'Cube kerékpárok > Cross-trekking kerékpár', undefined],
      ['bikes', 'Cube kerékpárok > Országúti kerékpár', undefined],
    ] as const)('reads the %s path %j as usage type %j', (slug, path, usageType) => {
      expect(specsOf(config, slug, { 'Webshop kategória': path })['usageType']).toEqual(usageType);
    });

    it.each([
      ['ebikes', 'Elektromos kerékpárok > Új E-bike Kerékpár > Gyerek E-bike kerékpár', 'Gyermek'],
      ['bikes', 'Cube kerékpárok > 12", 14" és futó gyerek kerékpár', 'Gyermek'],
      ['bikes', 'Cube kerékpárok > MTB kerékpár', undefined],
    ] as const)('reads the %s path %j as rider %j', (slug, path, gender) => {
      expect(specsOf(config, slug, { 'Webshop kategória': path })['gender']).toEqual(gender);
    });

    it.each([
      ['ebikes', 'Motor', 'Bosch Drive Unit Performance Line CX max. 120 Nm (BDU38)', 'motorBrand', 'Bosch'],
      ['ebikes', 'Fékek', 'Shimano XT BR-M8120, Hydr. Disc Brake (203/180)', 'rotorSizeFront', 203],
      ['ebikes', 'Fékek', 'Shimano XT BR-M8120, Hydr. Disc Brake (203/180)', 'rotorSizeRear', 180],
      ['ebikes', 'Fékek', 'Shimano BR-MT200, Hydr. Disc Brake (180/180)', 'brakeType', 'Tárcsa'],
      ['bikes', 'Fék', 'Tektro MD-C510, Flat Mount (160/160)', 'brakeType', 'Tárcsa'],
      ['bikes', 'Fék', 'Tektro MD-C510, Flat Mount (160/160)', 'rotorSizeFront', 160],
      // The travel is the standalone mm figure, not the 15x110mm axle.
      ['ebikes', 'Villa', 'RockShox Psylo Silver RC Air, Tapered, 15x110mm, Lockout, 120mm', 'forkTravel', 120],
      ['ebikes', 'Villa/Teleszkóp', 'SR Suntour XCR34X-Air, Tapered, 15x110mm, 100mm', 'forkTravel', 100],
      ['ebikes', 'Villa', 'CUBE Editor Full Carbon, 1 1/8" - 1 1/2" Tapered, Internal Cable Routing, 12x100mm', 'forkTravel', undefined],
      ['ebikes', 'Villa/Teleszkóp', 'SR Suntour XCR34X-Air, Tapered, 15x110mm, 100mm', 'forkType', 'Levegős'],
      ['ebikes', 'Villa', 'Fox 38 Float Performance GRIP, Tapered, 15x110mm, 170mm', 'forkType', 'Levegős'],
      ['bikes', 'Villa', 'Rigid Alloy Fork', 'forkType', 'Merev'],
      ['bikes', 'Villa/Teleszkóp', 'SR Suntour XCS, 100mm', 'forkType', undefined],
      // ETRTO only; a width alone ("2.4") is left to the LLM.
      ['ebikes', 'Első gumi', 'Conti Contact Urban, 50-622', 'tireSize', '50-622'],
      ['ebikes', 'Első gumi', 'Schwalbe Nobby Nic, Addix Performance, Kevlar, 2.4', 'tireSize', undefined],
      ['ebikes', 'Nyeregcső', 'CUBE Dropper Post, Handlebar Lever, Internal Cable Routing, 31.6mm', 'seatpostDiameter', 31.6],
      ['ebikes', 'Nyeregcső', 'CUBE Dropper Post, Handlebar Lever, Internal Cable Routing, 31.6mm', 'seatpostType', 'Teleszkópos (dropper)'],
      ['ebikes', 'Nyeregcső', 'CUBE Performance Post, 30.9mm', 'seatpostDiameter', 30.9],
      ['ebikes', 'Nyeregcső', 'CUBE Performance Post, 30.9mm', 'seatpostType', undefined],
      // One chainring only.
      ['ebikes', 'Hajtómű', 'ACID MTB Hybrid Pro, 38T', 'chainringTeeth', 38],
      ['ebikes', 'Hajtómű', 'ACID MTB Hybrid Pro', 'chainringTeeth', undefined],
      ['bikes', 'Hajtómű', 'Shimano GRX FC-RX820, 48x31T', 'chainringTeeth', undefined],
      ['ebikes', 'Fogaskoszorú', 'KMC LG-11, 11-50T', 'cassetteRange', '11-50T'],
      ['ebikes', 'Fogaskoszorú', 'Gates Rear Sprocket CDX, 34T', 'cassetteRange', undefined],
      // The shop writes axle x width; the stored form is width x axle.
      ['ebikes', 'Kerékszett', 'ACID SLX 30, 32/32 Spokes, 15x110mm/12x148mm, Tubeless Ready', 'hubSpacingFront', '110x15'],
      ['ebikes', 'Kerékszett', 'ACID SLX 30, 32/32 Spokes, 15x110mm/12x148mm, Tubeless Ready', 'hubSpacingRear', '148x12'],
      ['ebikes', 'Kerékszett', 'Newmen Performance X.R.25, 28/28 Spokes, 12x100mm / 12x142mm, Tubeless Ready', 'hubSpacingFront', '100x12'],
      ['ebikes', 'Kerékszett', 'Newmen Performance X.R.25, 28/28 Spokes, 12x100mm / 12x142mm, Tubeless Ready', 'hubSpacingRear', '142x12'],
      ['ebikes', 'Kerékszett', 'ACID SLX 30, 32/32 Spokes, 15x110mm/12x148mm, Tubeless Ready', 'tubeless', true],
      ['ebikes', 'Kerékszett', 'CUBE SX24, Disc, 36H', 'tubeless', undefined],
      ['ebikes', 'Kormány', 'CUBE Rise Trail Bar, 720mm', 'handlebarWidth', 720],
      ['ebikes', 'Kormány', 'Newmen Advanced Gravel Bar 318, Carbon, 31.8mm', 'handlebarWidth', undefined],
      ['bikes', 'Max. teherbírás', '140 kg', 'maxTotalWeight', 140],
      ['bikes', 'Max.teherbírás', '115 kg', 'maxTotalWeight', 115],
      ['bikes', 'Méret', '53 cm / M, átlagos testmagasságnak megfelelő', 'frameSize', 53],
      ['bikes', 'Méret', '53 cm / M, átlagos testmagasságnak megfelelő', 'frameSizeLabel', 'M'],
      // XXS is not in the label enum.
      ['bikes', 'Méret', '46 cm / XXS', 'frameSize', 46],
      ['bikes', 'Méret', '46 cm / XXS', 'frameSizeLabel', undefined],
      ['bikes', 'Bandázs', 'ACID Bartape CX', 'grips', 'ACID Bartape CX'],
      ['bikes', 'Rugós tag', 'RockShox Deluxe Select+, 190x42.5mm', 'rearShockModel', 'RockShox Deluxe Select+, 190x42.5mm'],
      ['bikes', 'Beépített kormány és kormányszár', 'CUBE Phenix Carbon Cockpit System', 'handlebar', 'CUBE Phenix Carbon Cockpit System'],
      ['bikes', 'Gumi elöl', 'Schwalbe Racing Ray, Super Race, Addix Speed, Kevlar, 2.25', 'tireModel', 'Schwalbe Racing Ray, Super Race, Addix Speed, Kevlar, 2.25'],
    ] as const)('reads a %s row %s: %j as %s %j', (slug, name, value, key, expected) => {
      expect(specsOf(config, slug, { [name]: value })[key]).toEqual(expected);
    });

    // A row an identity-relevant mapping reads goes to the identity call too.
    it('sends the size, shock and tyre row variants to the identity extraction', () => {
      for (const slug of ['bikes', 'ebikes']) {
        expect(config.categories?.[slug]?.identitySpecRows).toEqual(
          expect.arrayContaining(['Méret', 'Rugós tag', 'Gumi elöl', 'Gumi hátul']),
        );
      }
    });


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

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // The sku prefix as the schema's usage type, only where the prefix holds one
    // type (checked against every title of the 2026-10-20 feed). 0107 "Fitness"
    // holds the SOOT 20 gravel bike, 0108 "Országúti" gravel and fitness bikes,
    // 0109 "City" a singlespeed and a cyclocross: no row. The MTB prefixes hold a
    // fully (Spark 960), fitness, city and kids' bikes, so they keep the shop's
    // words, which no enum value matches.
    it.each([
      ['010100000065', 'Futóbicikli', { usageType: 'Futóbicikli', gender: 'Gyermek' }],
      ['010203000044', 'Gyerek', { usageType: 'Gyerek', gender: 'Gyermek' }],
      ['010300000001', 'BMX', { usageType: 'BMX' }],
      ['010500000622', 'Trekking', { usageType: 'Trekking' }],
      ['010600001409', 'Cross Trekking', { usageType: 'Cross Trekking' }],
      ['011000000001', 'Cruiser', { usageType: 'Cruiser' }],
      ['011200000001', 'Tandem', { usageType: 'Tandem' }],
      ['014000000001', 'Cyclocross', { usageType: 'Cyclocross' }],
      ['015000000001', 'Gravel', { usageType: 'Gravel' }],
      ['012000000258', 'MTB 29"', {}],
      ['013000000001', 'MTB 27.5"', {}],
      ['010400000001', 'MTB 26"', {}],
    ])('reads sku %s as %j and maps it to %j', async (sku, row, specs) => {
      expect(await extraRowOf(config, 'bikes', 'Webshop kategória', { sku })).toBe(row);
      expect(specsOf(config, 'bikes', { 'Webshop kategória': row })).toEqual(specs);
    });

    it.each(['010700000075', '010800000054', '010900000001'])(
      'gives sku %s, a prefix that mixes bike types, no row',
      async (sku) => {
        expect(await extraRowOf(config, 'bikes', 'Webshop kategória', { sku })).toBeUndefined();
      },
    );


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

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // Every e-bike title ends "(NNNWh, colour)"; it also covers the rows with an
    // empty description, where no other row names the capacity.
    it.each([
      ['CUBE Nuride Hybrid Pro 600 elektromos kerékpár (600Wh, chilli´n´black)', 600],
      ['Cube Touring Hybrid Deluxe SLX 800 férfi elektromos kerékpár (800Wh, slabgrey´n´chrome)', 800],
      ['FLYER Goroc2 6.30 HS elektromos kerékpár (750 Wh, cast silver gloss) - 45 km/h', 750],
    ])('reads the battery capacity from the title %j', async (name, capacity) => {
      const row = await extraRowOf(config, 'ebikes', 'Akkumulátor kapacitása (cím)', { name });
      expect(specsOf(config, 'ebikes', { 'Akkumulátor kapacitása (cím)': row ?? '' })).toMatchObject({
        batteryCapacity: capacity,
      });
    });

    // The description's motor and battery lines, already made into rows, now
    // read deterministically.
    it.each([
      ['Rásegítés sebességhatára', '25 km/h', { topSpeed: 25 }],
      ['Rásegítés sebességhatára', '45 km/h', { topSpeed: 45 }],
      ['Motor névleges teljesítménye', '250W', { motorPower: 250 }],
      ['Motor működési elve', 'Nyomatékszenzor', { sensorType: 'Nyomatékszenzor' }],
      [
        'Motor működési elve',
        'Nyomatékszenzor + integrált, 12 sebességes középagyváltó',
        { sensorType: 'Nyomatékszenzor' },
      ],
      ['Akkumulátor elhelyezése', 'vázcső belsejébe rejtett bölcsőben', { batteryPosition: 'Vázba integrált' }],
      ['Akkumulátor elhelyezése', 'vázra szerelt dokkolón', { batteryPosition: 'Külső' }],
      ['Akkumulátor technológiája', 'Li-ion', { batteryChemistry: 'Li-ion' }],
      ['Akkumulátor levehető', 'igen, kulccsal kinyitva', { batteryRemovable: true }],
    ])('maps the description row %s %j', (label, value, expected) => {
      expect(specsOf(config, 'ebikes', { [label]: value })).toMatchObject(expected);
    });

    it('leaves "gyártónként változó" without a removable-battery value', () => {
      expect(specsOf(config, 'ebikes', { 'Akkumulátor levehető': 'gyártónként változó' })['batteryRemovable']).toBeUndefined();
    });

    // Only a title word that names the rider; silence gives nothing (explicitOnly).
    it.each([
      ['Cube Touring Hybrid Deluxe SLX 800 férfi elektromos kerékpár (800Wh, slabgrey´n´chrome)', 'Férfi'],
      ['Cube Kathmandu Hybrid Pro 800 női elektromos kerékpár (800Wh, coal´n´black)', 'Női'],
      ['KTM Macina Tour CX 820 unisex elektromos kerékpár (800Wh, diamond black matt)', 'Uniszex'],
      ['SCOTT Sub Sport eRIDE 10 Men elektromos kerékpár (750Wh, zöld szín)', 'Férfi'],
      ['Bergamont E-Revox Edition EQ elektromos kerékpár férfi vázzal (500Wh, matt galaxy grey)', 'Férfi'],
      ['CUBE Nuride Hybrid Pro 600 elektromos kerékpár (600Wh, chilli´n´black)', undefined],
    ])('reads the rider from the title %j as %j', async (name, gender) => {
      const row = await extraRowOf(config, 'ebikes', 'Nem (cím)', { name });
      expect(row ? specsOf(config, 'ebikes', { 'Nem (cím)': row })['gender'] : undefined).toBe(gender);
    });

    // The article number's size suffix (Cube, Bergamont, Scott): a cm size or a
    // letter. KTM's and BULLS's numbers carry none.
    it.each([
      ['110220-54_df', { frameSize: 54 }],
      ['813700-50_cf', { frameSize: 50 }],
      ['111122-46E_cf', { frameSize: 46 }],
      ['111121-50T_tf', { frameSize: 50 }],
      ['1111101-54_tf', { frameSize: 54 }],
      ['290670-M_df', { frameSizeLabel: 'M' }],
      ['423630-L_df', { frameSizeLabel: 'L' }],
      ['1260161111_df', {}],
      ['657-45350_df', {}],
    ])('reads the size of sku %s as %j', async (sku, expected) => {
      const rows: Record<string, string> = {};
      for (const label of ['Vázméret (cikkszám, cm)', 'Vázméret jelölés (cikkszám)']) {
        const row = await extraRowOf(config, 'ebikes', label, { sku });
        if (row) rows[label] = row;
      }
      expect(pick(specsOf(config, 'ebikes', rows), SIZE_KEYS)).toEqual(expected);
    });


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

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // Every row states `New`: Google's word, read case-insensitively by the importer.
    it('reads availability as written and condition from its column', async () => {
      expect(config.mapping['availability']).toEqual({ field: 'availability' });
      expect(config.mapping['condition']).toEqual({ field: 'condition' });
      expect(await readText(config, 'condition', { condition: 'New' })).toBe('New');
    });

    // A feed row's specs as the importer builds them: the section's extra rows
    // (the shop's path, the title rows, the bikes' age row), then its specMapping.
    async function feedSpecs(slug: 'bikes' | 'ebikes', fields: Record<string, string>) {
      const rows: Record<string, string> = {};
      for (const { label } of config.categories?.[slug]?.extraSpecRows ?? []) {
        const value = await extraRowOf(config, slug, label, fields);
        if (value !== undefined) rows[label] = value;
      }
      return specsOf(config, slug, rows);
    }

    // The title names the gender in capitals on KTM (FÉRFI / NŐI / UNISEX) and in
    // lower case on Giant and Liv; a kids' bike says "Gyerek kerékpár" or "gyermek".
    it.each([
      ['ebikes', 'KTM MACINA FOLD NŐI Elektromos városi kerékpár - OLIVE PEARL', 'Női'],
      ['ebikes', 'KTM MACINA AERA 872 LFC UNISEX Elektromos MTB kerékpár - SMARAGD BLACK - több méretben', 'Uniszex'],
      [
        'ebikes',
        'KTM MACINA PROWLER PRESTIGE CX-R Di2 FÉRFI Összteleszkópos elektromos MTB kerékpár - SHARK BLUE+METALLIC BLACK MATT - több méretben',
        'Férfi',
      ],
      ['ebikes', 'LIV Lurra E+ 29" elektromos női MTB kerékpár - Lunar Eclipse', 'Női'],
      ['bikes', 'KTM REVELATOR 15 NŐI Országúti kerékpár - KEEN GREEN - több méretben', 'Női'],
      ['bikes', 'KTM WILD SPEED DISC 26 Gyerek kerékpár - 34', 'Gyermek'],
      ['bikes', 'GIANT ARX 20   gyermek cross/gravel kerékpár - Cobalt', 'Gyermek'],
      ['bikes', 'Tern Link B7 összecsukható kerékpár', undefined],
    ])('reads the %s gender off the title %j as %j', async (slug, title, gender) => {
      expect((await feedSpecs(slug as 'bikes' | 'ebikes', { title }))['gender']).toBe(gender);
    });

    // The bikes path opens with the gender; the title wins where both speak.
    it.each([
      ['Kerékpár > Férfi kerékpár > Összteleszkópos > 29"', 'Bottecchia 74A Shimano 105 - 2026', 'Férfi'],
      ['Kerékpár > Női kerékpár > Országúti (700, 622, 28")', 'Bottecchia 74A Shimano 105 - 2026', 'Női'],
      ['Kerékpár > Gyerek kerékpárok > 26" (14 éves kor felett)', 'KTM WILD SPEED 26 - 34', 'Gyermek'],
      ['Kerékpár > Férfi kerékpár > MTB > 29"', 'KTM MYROON ELITE NŐI 29" MTB kerékpár - BURNT ORANGE', 'Női'],
    ])('reads the bikes gender of path %j (title %j) as %j', async (product_type, title, gender) => {
      expect((await feedSpecs('bikes', { product_type, title }))['gender']).toBe(gender);
    });

    // Usage type: the path's unambiguous segments, then the title's bike-type word,
    // which wins (the e-bike path "Elektromos MTB kerékpárok" holds hardtails and
    // full-suspension bikes, and "City-Városi E-BIKE" holds the folding MACINA FOLD:
    // neither is mapped), then a kids' title word, which wins over both.
    it.each([
      [
        'bikes',
        'Kerékpár > Férfi kerékpár > Összteleszkópos > 29"',
        'KTM SCARP EXONIC FÉRFI Összteleszkópos MTB kerékpár - CARBON CRYSTAL RED - több méretben',
        'Összteleszkópos MTB',
      ],
      ['bikes', 'Kerékpár > Férfi kerékpár > MTB > 29"', 'KTM MYROON ELITE FÉRFI 29" MTB kerékpár - BURNT ORANGE - 38', 'MTB'],
      [
        'bikes',
        'Kerékpár > Férfi kerékpár > Férfi országúti kerékpár (700, 622, 28")',
        'KTM REVELATOR ALTO PRO FÉRFI Országúti kerékpár - CANDY BLUEGREY - több méretben',
        'Országúti',
      ],
      ['bikes', 'Kerékpár > Gyerek kerékpárok > 26" (14 éves kor felett)', 'KTM WILD SPEED DISC 26 Gyerek kerékpár - 34', 'Gyerek'],
      ['bikes', 'Kerékpár > Gyerek kerékpárok > 20" (7-9 éves korig)', 'GIANT ARX 20   gyermek cross/gravel kerékpár - Cobalt', 'Gyerek'],
      // The path alone (no type word in the title).
      ['bikes', 'Kerékpár > Női kerékpár > Országúti (700, 622, 28")', 'Bottecchia 74A Shimano 105 - 2026', 'Országúti'],
      ['ebikes', 'Kerékpár > Elektromos kerékpárok > Gravel E-BIKE', 'KTM MACINA GRAVELATOR SX 10 FÉRFI - MUDDY MATT', 'Gravel'],
      ['ebikes', 'Kerékpár > Elektromos kerékpárok > Trekking E-BIKE', 'KTM MACINA TOUR CX 810 GX AXS FÉRFI - TERRA', 'Trekking'],
      // The title's word.
      [
        'ebikes',
        'Kerékpár > Elektromos kerékpárok > Elektromos MTB kerékpárok',
        'KTM MACINA SCARP SX ELITE FÉRFI Összteleszkópos elektromos MTB kerékpár - FLAMING BLACK MATT - több méretben',
        'Összteleszkópos MTB',
      ],
      [
        'ebikes',
        'Kerékpár > Elektromos kerékpárok > Elektromos MTB kerékpárok',
        'KTM MACINA AERA FS ELITE LFC UNISEX Elektromos összteleszkópos MTB kerékpár - OLIVE PEARL MATT - több méretben',
        'Összteleszkópos MTB',
      ],
      [
        'ebikes',
        'Kerékpár > Elektromos kerékpárok > Elektromos MTB kerékpárok',
        'KTM MACINA TEAM 892 XL Di2 FÉRFI 29" Elektromos MTB kerékpár - OLIVE PEARL MATT - több méretben',
        'MTB',
      ],
      [
        'ebikes',
        'Kerékpár > Elektromos kerékpárok > Trekking E-BIKE',
        'KTM MACINA STYLE 840 FÉRFI Elektromos trekking- túra kerékpár - DIAMOND BLACK MATT - több méretben',
        'Trekking',
      ],
      [
        'ebikes',
        'Kerékpár > Férfi kerékpár > Összteleszkópos > 27.5"',
        'KTM MACINA CROSS CX 820 L NŐI Elektromos crosstrekking kerékpár - FLAMING GREY - több méretben',
        'Cross Trekking',
      ],
      ['ebikes', 'Kerékpár > Elektromos kerékpárok', 'Liv Avail Advanced E+ EL 0  - női elektromos országúti kerékpár - 2025', 'Országúti'],
      // Neither: left to the LLM.
      ['ebikes', 'Kerékpár > Elektromos kerékpárok > City-Városi E-BIKE', 'KTM MACINA FOLD NŐI Elektromos városi kerékpár - OLIVE PEARL', undefined],
      ['ebikes', 'Kerékpár > Elektromos kerékpárok > Elektromos MTB kerékpárok', 'KTM MACINA KAPOHO 8973 L FÉRFI - FRESH ORANGE', undefined],
    ])('reads the %s usage type of path %j (title %j) as %j', async (slug, product_type, title, usageType) => {
      expect((await feedSpecs(slug as 'bikes' | 'ebikes', { product_type, title }))['usageType']).toBe(usageType);
    });

    // Only full suspension is stated (the path segment or the title word); a
    // hardtail's fork is not, so it gets no value.
    it.each([
      ['bikes', 'Kerékpár > Férfi kerékpár > Összteleszkópos > 29"', 'KTM SCARP MT MASTER FÉRFI - 38', 'Első teleszkóp, hátsó rugóstag'],
      [
        'ebikes',
        'Kerékpár > Elektromos kerékpárok > Elektromos MTB kerékpárok',
        'KTM MACINA LYCAN 773 L FÉRFI Összteleszkópos elektromos MTB kerékpár - ELDERBERRY+BLACK MATT - több méretben',
        'Első teleszkóp, hátsó rugóstag',
      ],
      ['bikes', 'Kerékpár > Férfi kerékpár > MTB > 29"', 'KTM MYROON PRIME FÉRFI 29" MTB kerékpár - OLIVE PEARL - több méretben', undefined],
      [
        'ebikes',
        'Kerékpár > Elektromos kerékpárok > Elektromos MTB kerékpárok',
        'KTM MACINA TEAM 893 FÉRFI 29" Elektromos MTB kerékpár - DIAMOND BLACK MATT - több méretben',
        undefined,
      ],
    ])('reads the %s suspension of path %j (title %j) as %j', async (slug, product_type, title, suspension) => {
      expect((await feedSpecs(slug as 'bikes' | 'ebikes', { product_type, title }))['suspension']).toBe(suspension);
    });

    // Shimano Di2, SRAM AXS and SRAM's T-Type (Eagle Transmission, AXS only) shift electronically.
    it.each([
      ['ebikes', 'KTM MACINA TEAM 892 XL Di2 FÉRFI 29" Elektromos MTB kerékpár - OLIVE PEARL MATT - több méretben', 'Elektromos'],
      ['ebikes', 'KTM MACINA TOUR CX 810 GX AXS FÉRFI Elektromos trekking- túra kerékpár - TERRA - több méretben', 'Elektromos'],
      [
        'ebikes',
        "KTM MAC PROWLER EXONIC CX-R XX T-TYPE FÉRFI Összteleszkópos elektromos MTB kerékpár - FRESH'BURNT ORANGE+BLACK MATT - több méretben",
        'Elektromos',
      ],
      ['bikes', 'KTM SCARP MT EXONIC Di2 FÉRFI Összteleszkópos MTB kerékpár - CARBON', 'Elektromos'],
      ['ebikes', 'KTM MACINA STYLE 840 FÉRFI Elektromos trekking- túra kerékpár - DIAMOND BLACK MATT - több méretben', undefined],
    ])('reads the %s shifting actuation off the title %j as %j', async (slug, title, shiftingActuation) => {
      expect((await feedSpecs(slug as 'bikes' | 'ebikes', { title }))['shiftingActuation']).toBe(shiftingActuation);
    });

    // The kids' paths state the rider age in brackets: an "Életkor (kategória)"
    // row, written as the schema's "7-11 év" ("14 éves kor felett" → "14+ év").
    it('sends the bracketed rider age of a kids path as a bikes row', async () => {
      const product_type = 'Kerékpár > Gyerek kerékpárok > 26" (14 éves kor felett)';
      expect(await extraRowOf(config, 'bikes', 'Életkor (kategória)', { product_type })).toBe('14 éves kor felett');
      expect(
        await extraRowOf(config, 'bikes', 'Életkor (kategória)', { product_type: 'Kerékpár > Férfi kerékpár > MTB > 29"' }),
      ).toBeUndefined();
    });

    it.each([
      ['Kerékpár > Gyerek kerékpárok > 26" (14 éves kor felett)', '14+ év'],
      ['Kerékpár > Gyerek kerékpárok > 20" (7-9 éves korig)', '7-9 év'],
      ['Kerékpár > Férfi kerékpár > MTB > 29"', undefined],
    ])('reads the bikes recommended age of path %j as %j', async (product_type, recommendedAge) => {
      expect((await feedSpecs('bikes', { product_type, title: 'KTM WILD SPEED DISC 26 - 34' }))['recommendedAge']).toBe(
        recommendedAge,
      );
    });

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

  });

  describe("downhillendurokerekpar's Árukereső feed config", () => {
    const config = asFeedConfig(downhillendurokerekparArukeresoConfig);

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // Almost every title opens with the model year ("2023 SCOTT …"). Only a leading year counts: a year
    // inside a title ("CLASH RIDE 2022 Enduro") is left to the LLM, and a title without one stays empty.
    it.each([
      ['bikes', '2026 SCOTT Spark RC Team Kerékpár', 2026],
      ['bikes', ' 2023 SCOTT GENIUS ST 900 TUNED Enduro Kerékpár', 2023],
      ['bikes', '2021 KELLYS Gibon 30 Merev Enduro Kerékpár', 2021],
      ['ebikes', '2023 SCOTT STRIKE ERIDE 930 E-Bike', 2023],
      ['ebikes', '2023 KELLYS Theos F70 M/L 29/27.5 725Wh E-Bike', 2023],
      ['ebikes', 'SCOTT Contessa Patron eRIDE 900 E-Bike', undefined],
      ['bikes', 'COMMENCAL CLASH RIDE 2022 Enduro', undefined],
    ] as const)('reads the %s title %j as model year %j', async (slug, name, modelYear) => {
      const row = await extraRowOf(config, slug, 'Modellév (cím)', { name });
      expect(specsOf(config, slug, row ? { 'Modellév (cím)': row } : {})['modelYear']).toEqual(modelYear);
    });

    // The GRAVEL shelf also holds Sirrus X step-through fitness bikes, so the title word decides, not the
    // shelf. Every titled "Gravel" row is a drop-bar gravel bike (Speedster Gravel, 365, Diverge, Stigmata,
    // Turbo Creo among the e-bikes).
    it.each([
      ['bikes', '2023 SCOTT SPEEDSTER GRAVEL 40 EQ Kerékpár', 'Gravel'],
      ['bikes', '2025 COMMENCAL 365 RIDE CHALK Gravel', 'Gravel'],
      ['ebikes', '2026 Specialized Turbo Creo 2 Comp E5 SRAM Apex Gravel Kerékpár', 'Gravel'],
      ['bikes', '2026 Specialized Sirrus X 2.0 Step-Through', undefined],
      ['bikes', '2026 SCOTT Spark RC Team Kerékpár', undefined],
    ] as const)('reads the %s title %j as usage type %j', async (slug, name, usageType) => {
      const row = await extraRowOf(config, slug, 'Gravel (cím)', { name });
      expect(specsOf(config, slug, row ? { 'Gravel (cím)': row } : {})['usageType']).toEqual(usageType);
    });

    // The shop's shelves mix types: ENDURO and ALL-MOUNTAIN hold hardtails (Gibon "Merev Enduro", Chisel,
    // Rockhopper, META HT) next to full-suspension bikes, DOWNHILL a "gyerek downhill" bike, GRAVEL the
    // Sirrus X, GYEREK MTB push bikes. The path alone maps no usage type.
    it.each(['ENDURO > Kerékpárok', 'ALL-MOUNTAIN', 'DOWNHILL > Kerékpárok', 'GRAVEL', 'GYEREK MTB > 20"'])(
      'reads no usage type from the shelf %j alone',
      (path) => {
        expect(specsOf(config, 'bikes', { 'Webshop kategória': path })['usageType']).toBeUndefined();
      },
    );

    // The e-bike descriptions name the motor maker next to "motor"/"meghajtóegység"; "motorozás" (riding)
    // after a groupset name is not a motor.
    it.each([
      ['A belső kábelek és a gondosan megválasztott geometria az új, erőteljes Bosch motorral kombinálva', 'Bosch'],
      ['a SCOTT legújabb technológiáit kínálja a Bosch legújabb motorjával együtt.', 'Bosch'],
      ['a gondosan megválasztott geometria az új Bosch meghajtóegységgel kombinálva', 'Bosch'],
      ['A 85 Nm nyomatékú Bosch Performance Line CX Smart System motorral, a 800 Wh-s akkumulátorral', 'Bosch'],
      ['könnyebb, Shimano XT váltóval és all-mountain motorozáshoz tökéletes RockShox villával', undefined],
      ['akik egy trail bike-ra vágynak egy kompakt és csendes motorral kiegészítve', undefined],
    ] as const)('reads the e-bike description %j as motor brand %j', async (description, motorBrand) => {
      const row = await extraRowOf(config, 'ebikes', 'Motor márkája (leírás)', { description });
      expect(specsOf(config, 'ebikes', row ? { 'Motor márkája (leírás)': row } : {})['motorBrand']).toEqual(
        motorBrand,
      );
    });

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

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // Used bikes are kept out by the gate; the condition column (Google's New/Used/Refurbished) is the offer's.
    it('reads the offer condition from the condition column', async () => {
      expect(config.mapping['condition']).toEqual({ field: 'condition' });
      expect(await readText(config, 'condition', { condition: 'New' })).toBe('New');
    });

    // product_weight / shipping_weight are the shop's placeholder (10.00 kg on every bike, 20.00 kg on every
    // e-bike): never read.
    it('reads no weight column', () => {
      for (const section of Object.values(config.categories ?? {})) {
        const fields = (section.extraSpecRows ?? []).map((row) => row.field);
        expect(fields).not.toContain('product_weight');
        expect(fields).not.toContain('shipping_weight');
      }
    });

    // The gender column says Férfi or Női where the shop knows it, else "Nemtől független" on every other
    // row (the kids' bikes too): only the explicit two are read, so products don't split by gender. The
    // children's path gives Gyermek; an explicit column value wins over it (a KTM City Fun 26 "női városi"
    // sits among the children's bikes with gender Női).
    it.each([
      ['ebikes', { 'Nem': 'Női' }, 'Női'],
      ['ebikes', { 'Nem': 'Nemtől független' }, undefined],
      ['bikes', { 'Nem': 'Férfi' }, 'Férfi'],
      ['bikes', { 'Nem': 'Női' }, 'Női'],
      ['bikes', { 'Nem': 'Nemtől független' }, undefined],
      ['bikes', { 'Webshop kategória': 'KERÉKPÁR > Gyerek kerékpár > 24" kerékpár', 'Nem': 'Nemtől független' }, 'Gyermek'],
      ['bikes', { 'Webshop kategória': 'KERÉKPÁR > Gyerek kerékpár > 26" kerékpár', 'Nem': 'Női' }, 'Női'],
      ['bikes', { 'Webshop kategória': 'KERÉKPÁR > Trekking kerékpár > Uniszex trekking kerékpár', 'Nem': 'Nemtől független' }, undefined],
    ] as const)('reads the %s rows %j as rider %j', (slug, rows, gender) => {
      expect(specsOf(config, slug, rows)['gender']).toEqual(gender);
    });

    it.each(['ebikes', 'bikes'] as const)('turns the %s gender column into the Nem row', async (slug) => {
      expect(await extraRowOf(config, slug, 'Nem', { gender: 'Férfi' })).toBe('Férfi');
    });

    // The shop's path names one type per segment on 2,536 bike rows; promotions (AKCIÓINK), the Árukereső
    // export path and the used bikes name none.
    it.each([
      ['ebikes', 'E-BIKE > MTB E-Bike > Összteleszkópos MTB E-Bike', 'Összteleszkópos MTB'],
      ['ebikes', 'E-BIKE > MTB E-Bike > Merevfarú MTB E-Bike', 'MTB'],
      ['ebikes', 'E-BIKE > Gravel E-Bike', 'Gravel'],
      ['ebikes', 'E-BIKE > Országúti E-Bike', 'Országúti'],
      ['ebikes', 'E-BIKE > Trekking E-Bike > Férfi trekking E-Bike', 'Trekking'],
      ['ebikes', 'E-BIKE > Városi E-Bike', 'City'],
      ['ebikes', 'AKCIÓINK > MERIDA készletkisöprés', undefined],
      ['bikes', 'KERÉKPÁR > MTB kerékpár > Összteleszkópos MTB kerékpár', 'Összteleszkópos MTB'],
      ['bikes', 'KERÉKPÁR > MTB kerékpár > Merevfarú MTB kerékpár', 'MTB'],
      ['bikes', 'KERÉKPÁR > Gravel kerékpár', 'Gravel'],
      ['bikes', 'KERÉKPÁR > Országúti kerékpár', 'Országúti'],
      ['bikes', 'KERÉKPÁR > Triatlon kerékpár', 'Országúti'],
      ['bikes', 'KERÉKPÁR > Cyclocross kerékpár', 'Cyclocross'],
      ['bikes', 'KERÉKPÁR > Fitness kerékpár', 'Fitness'],
      ['bikes', 'KERÉKPÁR > Városi kerékpár', 'City'],
      ['bikes', 'KERÉKPÁR > Cross trekking kerékpár > Női cross trekking kerékpár', 'Cross Trekking'],
      ['bikes', 'KERÉKPÁR > Trekking kerékpár > Uniszex trekking kerékpár', 'Trekking'],
      ['bikes', 'KERÉKPÁR > Gyerek kerékpár > 20" kerékpár', 'Gyerek'],
      ['bikes', 'KERÉKPÁR > Használt kerékpár', undefined],
      ['bikes', 'arukereso > Kerékpár', undefined],
    ] as const)('reads the %s path %j as usage type %j', (slug, path, usageType) => {
      expect(specsOf(config, slug, { 'Webshop kategória': path })['usageType']).toEqual(usageType);
    });

    // The title's own type word (the one before "[elektromos] kerékpár"), or FS / Dirt in the model name.
    it.each([
      ['ebikes', 'KTM Macina Aera FS Elite LFC elektromos MTB kerékpár 2025 - fekete', 'FS'],
      ['ebikes', 'STEVENS E-Strada 6.3.4 FEQ városi elektromos kerékpár 2023 - fekete', 'városi'],
      ['ebikes', 'KTM Macina Kapoho Elite elektromos MTB kerékpár 2025 - fekete', undefined],
      ['bikes', 'MERIDA Dirt 500 MTB kerékpár 2026 - fekete', 'Dirt'],
      ['bikes', 'KTM X-Life Track Street férfi cross trekking kerékpár 2024 - fekete', 'cross trekking'],
      ['bikes', 'KTM City Fun 26 női városi kerékpár 2024 - pezsgő', 'városi'],
      ['bikes', 'MERIDA Silex 400 gravel kerékpár 2025 - zöld', 'gravel'],
      ['bikes', 'KTM Gravelator Elite 2X gravel kerékpár 2025 - szürke', 'gravel'],
    ] as const)('reads the %s title %j as type word %j', async (slug, title, word) => {
      expect(await extraRowOf(config, slug, 'Típus (cím)', { title })).toBe(word);
    });

    // A title word wins over the path where the path is the shop's broader shelf: two KTM Macina Aera FS
    // full-suspension e-MTBs sit among the hardtails, Merida's dirt-jump bikes too, eight "cross trekking"
    // bikes under Trekking and a "női városi" KTM City Fun 26 among the children's bikes.
    it.each([
      ['ebikes', 'E-BIKE > MTB E-Bike > Merevfarú MTB E-Bike', 'FS', 'Összteleszkópos MTB'],
      ['bikes', 'KERÉKPÁR > MTB kerékpár > Merevfarú MTB kerékpár', 'Dirt', 'Dirt'],
      ['bikes', 'KERÉKPÁR > Trekking kerékpár > Férfi trekking kerékpár', 'cross trekking', 'Cross Trekking'],
      ['bikes', 'KERÉKPÁR > Gyerek kerékpár > 26" kerékpár', 'városi', 'City'],
      ['bikes', 'AKCIÓINK > KTM készletkisöprés', 'városi', 'City'],
      ['bikes', 'arukereso > Kerékpár', 'országúti', 'Országúti'],
    ] as const)('reads the %s path %j with title word %j as %j', (slug, path, word, usageType) => {
      expect(specsOf(config, slug, { 'Webshop kategória': path, 'Típus (cím)': word })['usageType']).toEqual(usageType);
    });

    // The description states the battery as "<n> Wh" on 344 of 540 e-bikes, always the battery first (a range
    // extender comes after), and the torque as "<n> Nm" on 77.
    it.each([
      ['…a 800 Wh-s Bosch PowerTube akkumulátor kombinációja…', 800],
      ['…400 Wh Bosch CompactTube akkumulátorral…', 400],
      ['…eltávolítható 750 Wh-s akkumulátorral és az opcionális 360 Wh-s hatótávnövelővel…', 750],
      ['A KTM Macina Lycan 891 elektromos MTB kerékpár…', undefined],
    ] as const)('reads the battery capacity of %j as %j', async (description, batteryCapacity) => {
      const row = await extraRowOf(config, 'ebikes', 'Akkumulátor (leírás)', { description });
      expect(specsOf(config, 'ebikes', row ? { 'Akkumulátor (leírás)': row } : {})['batteryCapacity']).toEqual(batteryCapacity);
    });

    it.each([
      ['…a Bosch Performance CX motor 85 Nm-es nyomatékával…', 85],
      ['A Bosch Performance SX motor 55 Nm nyomatékkal…', 55],
      ['…a 800 Wh-s Bosch PowerTube akkumulátor…', undefined],
    ] as const)('reads the torque of %j as %j', async (description, torque) => {
      const row = await extraRowOf(config, 'ebikes', 'Nyomaték (leírás)', { description });
      expect(specsOf(config, 'ebikes', row ? { 'Nyomaték (leírás)': row } : {})['torque']).toEqual(torque);
    });

    // "<n> sebességes" is the whole drivetrain on an e-bike (one chainring); on a bike it is often the cassette
    // alone (a 2x12 Merida Reacto says "12 sebességes"), so a bike reads only "AxB sebességes" or a hub gear's
    // count (Nexus, Alfine, Pinion). A title's "1x12" / "2x12" counts too.
    it.each([
      ['ebikes', 'A TRP A12 12 sebességes váltórendszer…', 12, undefined],
      ['ebikes', 'A Shimano CUES 10 sebességes váltórendszer…', 10, undefined],
      ['bikes', 'a Shimano 2x8 sebességes váltórendszere…', 16, 2],
      ['bikes', 'A Shimano Deore 3x10 sebességes váltórendszer…', 30, 3],
      ['bikes', 'A Shimano Deore XT 1x12 sebességes hajtásrendszer…', 12, 1],
      ['bikes', 'A Shimano Nexus 8 sebességes agyváltója…', 8, undefined],
      ['bikes', 'a Shimano Deore XT 12 sebességes váltórendszer…', undefined, undefined],
      ['bikes', 'A Shimano 105 11-sebességes váltórendszer…', undefined, undefined],
    ] as const)('reads the %s description %j as %j gears on %j chainrings', async (slug, description, gearCount, chainringCount) => {
      const row = await extraRowOf(config, slug, 'Sebességek (leírás)', { description });
      const specs = specsOf(config, slug, row ? { 'Sebességek (leírás)': row } : {});
      expect(specs['gearCount']).toEqual(gearCount);
      expect(specs['chainringCount']).toEqual(chainringCount);
    });

    it.each([
      ['RIDLEY Astr GRX600 2x12 gravel kerékpár - fekete', 24, 2],
      ['RIDLEY Blast CUES 1x11 MTB kerékpár - fekete', 11, 1],
      ['STEVENS 3X Lady cross trekking kerékpár 2022 - fekete', undefined, undefined],
    ] as const)('reads the title %j as %j gears on %j chainrings', async (title, gearCount, chainringCount) => {
      const row = await extraRowOf(config, 'bikes', 'Sebességek (cím)', { title });
      const specs = specsOf(config, 'bikes', row ? { 'Sebességek (cím)': row } : {});
      expect(specs['gearCount']).toEqual(gearCount);
      expect(specs['chainringCount']).toEqual(chainringCount);
    });

    // KTM's descriptions state the bike's weight as "<n> kg-os súlyával / tömegével" (135 rows); "<n> kg alatt"
    // (under n kg) is not a weight.
    it.each([
      ['bikes', 'A 11.9 kg-os súlyával ez egy sokoldalú bringa', 11.9],
      ['bikes', 'Mindössze 7.7 kg-os tömegével ideális választás', 7.7],
      ['ebikes', 'A 25 kg-os súlyával egy kompromisszumok nélküli…', 25],
      ['bikes', 'a váz súlya 9 kg alatt marad', undefined],
    ] as const)('reads the %s description %j as weight %j', async (slug, description, weight) => {
      const row = await extraRowOf(config, slug, 'Tömeg (leírás)', { description });
      expect(specsOf(config, slug, row ? { 'Tömeg (leírás)': row } : {})['weight']).toEqual(weight);
    });

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

    // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).

    // Scott's 6-digit model number behind SC<yy>, without size or colour code.
    // Cube keeps its item number + size: every other Cube seller stores that
    // form (akosbike/speedbike 1140120L, mangobike 1135500XS), and an MPN
    // lookup matches exactly.
    it.each([
      ['SC22286290_XL', '286290'],
      ['SC22286379-29_M', '286379'],
      ['SC26425706MNT_S', '425706'],
      ['SC24420643_M', '420643'],
      ['812900_58', '81290058'],
      ['KTM2622604481CANBLU_S', undefined],
      ['TR530189BLK_M', undefined],
    ])('reads the MPN %j as %j', async (identifier, mpn) => {
      expect(await readText(config, 'mpn', { identifier })).toBe(mpn);
    });

    it('gives bikes the title and description rows, not the drive rows', () => {
      const labels = (config.categories?.['bikes']?.extraSpecRows ?? []).map((row) => row.label);
      expect(labels).toEqual([
        'Webshop kategória',
        'Modellév (cím)',
        'Futóbicikli (cím)',
        'Kerékméret (leírás)',
        'Váz anyaga (leírás)',
        'Villa rugóútja (leírás)',
      ]);
    });

    // Every bike and e-bike title ends in "<year> <size>" (982 of 984 rows);
    // four digits, so "eRide 20" or "Scale 940" never read as a year.
    it.each([
      ['ebikes', 'Scott Strike eRide 930 kerékpár 2021 XL', 2021],
      ['ebikes', 'Scott Sub Sport eRide 20 Lady kerékpár 2024 S', 2024],
      ['ebikes', 'Cube Nuroad Hybrid C:62 Race 400X E-gravel kerékpár 2027', 2027],
      ['bikes', 'Cube Aim One 29 MTB kerékpár 2027 M', 2027],
      ['bikes', 'Cube Nature EXC FE kerékpár 2027 58', 2027],
    ] as const)('reads the %s model year off the title %j', async (slug, name, year) => {
      const row = await extraRowOf(config, slug, 'Modellév (cím)', { name });
      expect(specsOf(config, slug, { 'Modellév (cím)': row ?? '' })).toMatchObject({ modelYear: year });
    });

    it('reads no model year off a title without one', async () => {
      expect(await extraRowOf(config, 'bikes', 'Modellév (cím)', { name: 'Scott Spark RC Comp 29 MTB kerékpár M' })).toBeUndefined();
    });

    // Only the category paths that hold one bike type (checked title by title
    // on the 2026-10-20 feed). MTB (hardtail and fully), Cross, Fitness,
    // Városi and the e-bike paths other than eJunior mix types: the identity
    // extraction decides those.
    it.each([
      ['bikes', 'Kerékpárok / Országúti', 'Országúti'],
      ['bikes', 'Kerékpárok / Gravel', 'Gravel'],
      ['bikes', 'Kerékpárok / Trekking', 'Trekking'],
      ['bikes', 'Kerékpárok / Junior, gyerek', 'Gyerek'],
      ['ebikes', 'Elektromos kerékpárok / eJunior', 'Gyerek'],
    ] as const)('reads the %s usage type off the path %j', (slug, path, usageType) => {
      expect(specsOf(config, slug, { 'Webshop kategória': path })).toMatchObject({ usageType });
    });

    it.each([
      ['bikes', 'Kerékpárok / MTB'],
      ['bikes', 'Kerékpárok / Cross'],
      ['bikes', 'Kerékpárok / Fitness'],
      ['bikes', 'Kerékpárok / Városi'],
      ['ebikes', 'Elektromos kerékpárok / eMTB, terepre'],
      ['ebikes', 'Elektromos kerékpárok / eOrszágúti, eGravel'],
      ['ebikes', 'Elektromos kerékpárok / eTúra, eVárosi'],
      ['ebikes', 'Elektromos kerékpárok / eATB, minden terepre'],
    ] as const)('leaves the %s usage type of the mixed path %j to the identity extraction', (slug, path) => {
      expect(specsOf(config, slug, { 'Webshop kategória': path })['usageType']).toBeUndefined();
    });

    // The junior path holds the balance bikes too; their titles say so.
    it.each([
      ['Kellys Alpina Tornado futóbicikli 2020 12', 'Futóbicikli'],
      ['Polisport futó kerékpár 2021 12', 'Futóbicikli'],
      ['Cube Numove 120 Walk futó kerékpár 2026 12', 'Futóbicikli'],
      ['Cube Numove 160 kerékpár 2025 16', 'Gyerek'],
    ])('reads the junior title %j as %j', async (name, usageType) => {
      const balance = await extraRowOf(config, 'bikes', 'Futóbicikli (cím)', { name });
      const rows: Record<string, string> = { 'Webshop kategória': 'Kerékpárok / Junior, gyerek' };
      if (balance) rows['Futóbicikli (cím)'] = balance;
      expect(specsOf(config, 'bikes', rows)).toMatchObject({ usageType });
    });

    // The torque row holds the description's first Nm figure (always the
    // motor's on the feed).
    it.each([
      ['85Nm', 85],
      ['55 Nm', 55],
      ['120Nm', 120],
    ])('reads the torque row %j as %j', (raw, torque) => {
      expect(specsOf(config, 'ebikes', { 'Motor nyomatéka': raw })).toMatchObject({ torque });
    });

    // The motor sentence ends at "akkumulátor": the capacity is the last
    // figure before it, with or without Wh ("PowerTube 625 akkumulátor"), and
    // never the motor's watts. The rated 250 W is motorPower, never peak.
    it.each([
      ['Bosch Performance CX 250W motor és 750Wh akkumulátor', 750, 250],
      ['Bosch SX motor, 400 Wh akkumulátor', 400, undefined],
      ['A Bosch Performance motorja egy 540 Wh-s akkumulátor', 540, undefined],
      ['Bosch Performance Generation 3 (75Nm) Cruise (250W) Smart System motor és PowerTube 625 akkumulátor', 625, 250],
      ['Bosch Performance Line BDU33 (max 75Nm) motor Bosch Purion 200 kijelző Bosch PowerTube 600 w akkumulátor', 600, undefined],
      ['Bosch Performance Line Speed (85Nm, 250 W) motor PowerTube 750wh akkumulátor', 750, 250],
      ['Bosch Performance CX Generation 4 (85Nm) Cruise (250 Watt) motor és Powertube 750 akkumulátor', 750, 250],
      ['Bosch PowerTUBE 750Wh SMART SYSTEM akkumulátor', 750, undefined],
      ['legmodernebb teljesítményű motor- és akkumulátor', undefined, undefined],
      ['Hyena agymotor, kijelző és akkumulátor: motor: MRC-E250F, kijelző: CE-EL19A, akkumulátor', undefined, undefined],
    ])('reads the drive row %j as %j Wh and %j W', (row, batteryCapacity, motorPower) => {
      const specs = specsOf(config, 'ebikes', { 'Motor és akkumulátor': row });
      expect(specs['batteryCapacity']).toBe(batteryCapacity);
      expect(specs['motorPower']).toBe(motorPower);
      expect(specs['motorPeakPower']).toBeUndefined();
    });

    // A capacity the description names outside a motor sentence; a range
    // extender's (PowerMore, külső, kiegészítő, -bővítő, -erősítő) never.
    it.each([
      ['Solace 360 Wh-s belső akkumulátorral és opcionális 160 Wh-s külső hatótávolság-növelővel', '360 Wh'],
      ['a 400 Wh-s akkumulátort is beépítettük az alsó csőbe', '400 Wh'],
      ['Sőt, a vázra pluszban felszerelhetsz egy 250 Wh PowerMore kiegészítő akkumulátort.', undefined],
      ['egy opcionális 250 Wh-s kiegészítő akkumulátorral', undefined],
      ['a +250 Wh-s akkumulátor-erősítő', undefined],
      ['egy további 250 Wh-s akkumulátorbővítő is', undefined],
    ])('reads the battery off the description %j as %j', async (description, row) => {
      expect(await extraRowOf(config, 'ebikes', 'Akkumulátor (leírás)', { description })).toBe(row);
    });

    // The motor sentence wins over the description-wide figure.
    it('prefers the drive row capacity', () => {
      expect(
        specsOf(config, 'ebikes', {
          'Akkumulátor (leírás)': '250 Wh',
          'Motor és akkumulátor': 'Bosch SX motor és 400 Wh akkumulátor',
        }),
      ).toMatchObject({ batteryCapacity: 400 });
      expect(specsOf(config, 'ebikes', { 'Akkumulátor (leírás)': '360 Wh' })).toMatchObject({ batteryCapacity: 360 });
    });

    // The descriptions open with the wheel size ("29"-es mountain bike",
    // "Összteleszkópos 29"-es E-bike", "16-os gyerek kerékpár"); a size
    // further in is a tyre width (2,25 colos) or a per-size note.
    it.each([
      ['ebikes', 'Összteleszkópos 29"-es E-bike. Bosch Performance CX 250W motor', 29],
      ['ebikes', '27.5" junior e-kerékpár. A Reaction Hybrid Rookie', 27.5],
      ['ebikes', '24"-os gyerek elektromos kerékpár 124-141 cm testmagasság', 24],
      ['bikes', '16-os gyerek kerékpár. 90-115 cm testmagassághoz ajánlott.', 16],
      ['bikes', 'Női 27.5-es mountain bike. Megbízható', 27.5],
      ['bikes', '29-es mountain bike. Az Attention', 29],
      ['bikes', 'Könnyűsúlyú kerékpár karbon HMF váz, széles, 2,25 colos gumik', undefined],
      ['bikes', 'Női mountain bike. XS, S méret 27.5" kerékkel, az M és L 29"-es kerékkel', undefined],
    ] as const)('reads the %s wheel size off the description %j as %j', async (slug, description, wheelSize) => {
      const row = await extraRowOf(config, slug, 'Kerékméret (leírás)', { description });
      expect(row ? specsOf(config, slug, { 'Kerékméret (leírás)': row })['wheelSize'] : undefined).toBe(wheelSize);
    });

    // The first material the description names for the frame ("váz",
    // "vázzal", "karbonváz"), never the fork's, bar's or a general remark
    // about the range ("karbon- és alumíniumvázak").
    it.each([
      ['Könnyűsúlyú kerékpár Alloy SL 6061 aluminium váz.', 'Alumínium'],
      ['Könnyűsúlyú kerékpár karbon HMF váz.', 'Karbon'],
      ['Aluminum 6061 váz, merev villa', 'Alumínium'],
      ['Az elegáns C:62 karbonváz a Bosch SX motorját', 'Karbon'],
      ['Karbon villa, Shimano 105 váltó. Aluminium 6061 merev villa', undefined],
      ['A modelltől függően a kerékpárosok karbon- és alumíniumvázak közül választhatnak. Premium karbon váz', 'Karbon'],
    ])('reads the frame material off the description %j as %j', async (description, frameMaterial) => {
      const row = await extraRowOf(config, 'bikes', 'Váz anyaga (leírás)', { description });
      expect(row ? specsOf(config, 'bikes', { 'Váz anyaga (leírás)': row })['frameMaterial'] : undefined).toBe(frameMaterial);
    });

    // Only a travel the run-on list ties to the fork ("<fork> villa, 130 mm
    // rugóúttal"); a frame's or a rear shock's travel names no fork.
    it.each([
      ['RockShox Pike Select RL3 Air villa, 130 mm rugóúttal Shimano MT501 (180/180)', 130],
      ['FOX 36 Float Rythm Air GRIP villával, 160 mm rugóúttal FOX Nude 5T', 160],
      ['Fox villája 120 mm rugóúttal rendelkezik.', 120],
      ['RockShox Flight Attendant elektronikus első és hátsó felfüggesztés, 120 mm rugóúttal', undefined],
      ['Vegyük az eddigi legjobb Cross-Country/Trail Spark 900-at, 130 mm-es rugóúttal', undefined],
    ])('reads the fork travel off the description %j as %j', async (description, forkTravel) => {
      const row = await extraRowOf(config, 'ebikes', 'Villa rugóútja (leírás)', { description });
      expect(row ? specsOf(config, 'ebikes', { 'Villa rugóútja (leírás)': row })['forkTravel'] : undefined).toBe(forkTravel);
    });


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
    // identifier carries the manufacturer's code with its size, so those give none,
    // except Scott's (SC<yy><6 digits>): its 6-digit model number is the form the
    // other shops store.
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
      ['SC21280469_XL', '280469'],
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

      // 2026-10-23 shop review fixes (docs/shop-reviews/2026-10-23-all.md).
    it.each([
      // The leaf of the shop's category path, where it names one use only.
      ['ebikes', 'Webshop kategória', 'Termékek > E-Bike > Városi e-kerékpárok', 'usageType', 'City'],
      ['ebikes', 'Webshop kategória', 'Termékek > E-Bike > Túra, trekking, cross e-kerékpárok > Trekking, túra e-kerékpárok', 'usageType', 'Trekking'],
      ['bikes', 'Webshop kategória', 'Termékek > Kerékpárok > Dirt és BMX kerékpárok > Dirt kerékpárok', 'usageType', 'Dirt'],
      ['bikes', 'Webshop kategória', 'Termékek > Kerékpárok > Országúti és fitnesz kerékpárok > Gravel kerékpárok', 'usageType', 'Gravel'],
      ['bikes', 'Webshop kategória', 'Termékek > Kerékpárok > Trekking és Túra kerékpárok > Cross, cross trekking kerékpárok', 'usageType', 'Cross Trekking'],
      // MTB holds hardtails and full-suspension bikes, kids' bikes balance bikes too.
      ['ebikes', 'Webshop kategória', 'Termékek > E-Bike > MTB e-kerékpárok', 'usageType', undefined],
      ['bikes', 'Webshop kategória', 'Termékek > Kerékpárok > MTB kerékpárok', 'usageType', undefined],
      ['bikes', 'Webshop kategória', 'Termékek > Kerékpárok > Gyerekkerékpárok', 'usageType', undefined],
      // Gender and rider height from the title (the Név row).
      ['ebikes', 'Név', 'KELLYS E-Carson 10 SH 504Wh 28" férfi elektromos túra/trekking kerékpár, Teal, L (178-190cm)', 'gender', 'Férfi'],
      ['ebikes', 'Név', 'KELLYS Tayen R50 29" 720Wh MTB hardtail női elektromos kerékpár, Pink, M (166-178cm)', 'gender', 'Női'],
      ['bikes', 'Név', 'KELLYS Naga Air Belt 20" gyermek MTB kerékpár, Blue', 'gender', 'Gyermek'],
      ['bikes', 'Név', 'KELLYS Kite 12" gyermek tanulókerékpár / futóbicikli, Red', 'gender', 'Gyermek'],
      ['bikes', 'Név', 'KELLYS Soot 20 28" gravel kerékpár, M (175-190cm)', 'gender', undefined],
      ['ebikes', 'Név', 'KELLYS Theos F60 SH 29"/27.5" 820Wh MTB/enduro fully elektromos kerékpár, Space Grey, L', 'gender', undefined],
      // A child seat or a kid-carrying cargo bike is no kids' bike.
      ['ebikes', 'Név', 'Elektromos gyerekszállító cargo kerékpár, gyermekülés-tartóval', 'gender', undefined],
      ['ebikes', 'Név', 'KELLYS E-Carson 30 P 725Wh 28" férfi elektromos túra/trekking kerékpár, Magic Blue, M (170-180cm)', 'recommendedRiderHeight', '170-180 cm'],
      ['bikes', 'Név', 'KELLYS Soot 20 28" gravel kerékpár, M (175-190cm)', 'recommendedRiderHeight', '175-190 cm'],
      ['bikes', 'Név', 'KELLYS Spider X70 29" MTB XC kerékpár, Thunderstorm Blue, M (165-180cm)', 'recommendedRiderHeight', '165-180 cm'],
      // A kids' bike's single frame size and its rider height; the adult rows list every size.
      ['bikes', 'Vázméret', '245 mm (100-110 cm testméret)', 'recommendedRiderHeight', '100-110 cm'],
      ['bikes', 'Vázméret', '235mm (115-135 cm testméret)', 'seatTubeLength', 235],
      ['bikes', 'Vázméret', 'M (155-174cm), L (169-188cm)', 'recommendedRiderHeight', undefined],
      ['bikes', 'Vázméret', 'M (155-174cm), L (169-188cm)', 'seatTubeLength', undefined],
      // Fork travel: the comma- or slash-delimited "NNN mm"; a thru-axle or a rigid fork gives none.
      ['bikes', 'Villa', 'SR Suntour XCR32 Coil LOR DS (26), 100mm, coil / Speed Lockout', 'forkTravel', 100],
      ['bikes', 'Villa', 'SR Suntour NEX HLO P, 63 mm, coil / Speed Lockout', 'forkTravel', 63],
      ['bikes', 'Villa', 'SR Suntour XCM34 (29) Boost, 130mm, coil spring / 15mm thru axle', 'forkTravel', 130],
      ['bikes', 'Villa', 'Rock Shox Recon Silver RL (29) Boost, 100 mm, Solo Air / Motion Control / OneLoc Remote Lockout', 'forkTravel', 100],
      ['ebikes', 'Villa', 'SR Suntour XCM32-Air LOR DS (29") / 120mm, air / Speed Lockout /15mm thru axle', 'forkTravel', 120],
      ['ebikes', 'Villa', 'Rock Shox Domain R (29") Boost, 150 mm, 38mm stanchions, DebonAir / Motion Control', 'forkTravel', 150],
      ['bikes', 'Villa', 'Kellys Carbon Disc / 1.5" tapered steerer / flat mount disc brake / 12 mm thru axle', 'forkTravel', undefined],
      ['bikes', 'Villa', 'Kellys Carbon Disc - 1.5 tapered steerer, flat mount disc brake, 12x100 mm thru axle', 'forkTravel', undefined],
      // Battery voltage from the Motor row, chemistry from the Akkumulátor row.
      ['ebikes', 'Motor', 'Shimano Steps E6100, 60 Nm, 36 V', 'batteryVoltage', 36],
      ['ebikes', 'Motor', 'Panasonic GX Ultimate, 95Nm, 36V', 'batteryVoltage', 36],
      ['ebikes', 'Akkumulátor', 'KELLYS Re-Charge V10 Li-ion internal removable 720Wh / capacity 20Ah, powered by BMZ', 'batteryChemistry', 'Li-ion'],
      ['ebikes', 'Akkumulátor', 'Shimano BT-E8016, 630 Wh / capacity 17.5 Ah', 'batteryChemistry', undefined],
      // The e-bike system only where the Motor row names it.
      ['ebikes', 'Motor', 'SHIMANO STEPS E7000, 36V', 'ebikeSystem', 'Shimano Steps'],
      ['ebikes', 'Motor', 'Shimano EP801, 85Nm, 36V', 'ebikeSystem', undefined],
      ['bikes', 'Nyeregcső', 'KLS Active - diam 30.9mm / length 300mm', 'seatpostDiameter', 30.9],
      ['bikes', 'Nyeregcső', 'KLS Active 30.9x350 mm', 'seatpostDiameter', 30.9],
      ['bikes', 'Nyeregcső', 'alu - diam 27.2 mm / length 270 mm', 'seatpostDiameter', 27.2],
      ['bikes', 'Nyeregcső', 'acél, állítható', 'seatpostDiameter', undefined],
      ['ebikes', 'Kerékagy, első', 'Shimano MT400-B Disc Center Lock (32H)', 'hubType', 'CenterLock'],
      ['bikes', 'Kerékagyak', 'KLS Firework Disc (32 holes)', 'hubType', undefined],
      ['bikes', 'Fogaskoszorú', 'Shimano CS-HG200-9 (11-34T)', 'cassetteRange', '11-34T'],
      ['bikes', 'Fogaskoszorú', 'Shimano Deore CS-M6100-12 (10-51T)', 'cassetteRange', '10-51T'],
      // Either of two cassettes, or a single cog, gives none.
      ['ebikes', 'Fogaskoszorú', 'Shimano Linkglide CS-LG300-9 (11-41T) VAGY Shimano CS-HG201-9 (11-36T)', 'cassetteRange', undefined],
      ['bikes', 'Fogaskoszorú', 'single 16T sprocket', 'cassetteRange', undefined],
      ['bikes', 'Féktárcsák', '160 mm / 160 mm', 'rotorSizeRear', 160],
      ['bikes', 'Féktárcsák', '180mm front / 160mm rear', 'rotorSizeRear', 160],
      ['ebikes', 'Féktárcsák', 'Shimano RT64 220 mm front / Shimano EM300 203 mm rear', 'rotorSizeRear', 203],
      ['bikes', 'Féktárcsák', '180mm', 'rotorSizeRear', undefined],
      // Hub spacing as <spacing>x<axle>; the shop writes <axle>x<spacing>, and a
      // 12x162 / 12x170 / 12x177 / 12x181 rear figure is a thru-axle length.
      ['ebikes', 'Rögzített tengely, első', 'SR Suntour 15x110mm', 'hubSpacingFront', '110x15'],
      ['ebikes', 'Rögzített tengely', 'ROCK SHOX Maxle Stealth 15x110mm front / NOVATEC 12x148mm rear', 'hubSpacingFront', '110x15'],
      ['ebikes', 'Rögzített tengely', 'ROCK SHOX Maxle Stealth 15x110mm front / NOVATEC 12x148mm rear', 'hubSpacingRear', '148x12'],
      ['bikes', 'Rögzített tengely', 'Rock Shox Maxle Lite 15x110mm front / Novatec 12x170mm rear', 'hubSpacingRear', undefined],
      ['ebikes', 'Rögzített tengely, hátsó', 'Novatec 12x181mm', 'hubSpacingRear', undefined],
      ['bikes', 'Tengelyrögzítés', '12x118 mm front / 12x162 mm rear', 'hubSpacingFront', undefined],
      ['ebikes', 'Kerékagy, hátsó', 'Deore TC500-B Disc Center Lock (12x148 mm / 32 holes)', 'hubSpacingRear', '148x12'],
      ['bikes', 'Kerékagyak', 'SHIMANO MT400-B Disc Center Lock (15x110mm / 12x148mm / 32 holes)', 'hubSpacingFront', '110x15'],
      ['bikes', 'Villa', 'Kellys Carbon Disc - 1.5 tapered steerer, flat mount disc brake, 12x100 mm thru axle', 'hubSpacingFront', '100x12'],
      // A row of one colour is this listing's, as the shop writes it.
      ['ebikes', 'Szín', 'grey', 'color', 'grey'],
      ['ebikes', 'Szín', 'Magic Green', 'color', 'Magic Green'],
      // A row naming two years gives none, not the first.
      ['bikes', 'Modell év', '2020/2021', 'modelYear', undefined],
    ] as const)('reads a %s row %s: %j as %s %j', (slug, name, value, key, expected) => {
      expect(specsOf(config, slug, { [name]: value })[key]).toEqual(expected);
    });

    // The title wins over a kids' frame row, and the Név row is the feed's name column.
    it('reads the rider height from the title over the frame row', () => {
      expect(
        specsOf(config, 'bikes', {
          Vázméret: '245mm (100-110 cm testméret)',
          Név: 'KELLYS Emma 16" gyermek kerékpár, Pink (105-115cm)',
        })['recommendedRiderHeight'],
      ).toBe('105-115 cm');
    });

    it('sends the title to the spec mapping and the identity extraction as the Név row', async () => {
      const name = 'KELLYS Clea 90 28" női cross kerékpár, Dark Red, M (167-181cm)';
      for (const slug of ['bikes', 'ebikes']) {
        expect(await extraRowOf(config, slug, 'Név', { name })).toBe(name);
        expect(config.categories?.[slug]?.identitySpecRows).toContain('Név');
      }
    });

    // The Motor row's voltage only where the battery row states none.
    it('prefers the battery row voltage', () => {
      expect(
        specsOf(config, 'ebikes', { Motor: 'Bafang M420, 36V', Akkumulátor: 'Samsung 48V 14 Ah (672 Wh)' })['batteryVoltage'],
      ).toBe(48);
    });


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
