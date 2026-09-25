import {
  ArukeresoSourceConfig,
  ProductSourceConfig,
  ProductSourceType,
  ScrapingSourceConfig,
  ProductSourceConfigValidatorService,
  SourceSpecMapping,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import {
  ProductSpecNormalizationService,
  SpecExtractionService,
} from '@fittkereso-backend/product';
import { pick } from 'lodash';
import ebikeshopConfig from './ebikeshop.config.json';
import speedbikeConfig from './speedbike.config.json';
import speedbikeArukeresoConfig from './speedbike-arukereso.config.json';
import speedbikeGoogleshopConfig from './speedbike-googleshop.config.json';
// The size specs are read against the category's real, current schema, as
// speedbike-detail-page.spec.ts does, for the same reason.
// eslint-disable-next-line @nx/enforce-module-boundaries
import ebikesJsonSchema from '../../../../../config/src/lib/categories/ebikes/jsonSchema.json';

const SIZE_KEYS = ['frameSize', 'frameSizeLabel'];

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

  beforeAll(() => {
    validator = new ProductSourceConfigValidatorService();
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

  it('validates the ebikeshop config against the config schema', () => {
    assertConfigValid(ebikeshopConfig as unknown as ScrapingSourceConfig, 'ebikeshop');
  });

  it('validates the speedbike config against the config schema', () => {
    assertConfigValid(speedbikeConfig as unknown as ScrapingSourceConfig, 'speedbike');
  });

  it('ebikeshop config resolves every product to the single ebikes category', () => {
    const config = ebikeshopConfig as unknown as ScrapingSourceConfig;
    expect(config.detailPage.category.slugLookup).toEqual([
      { when: { always: true }, slug: 'ebikes' },
    ]);
  });

  // ebikeshop's listing paginates on `oldal` (Hungarian for "page") — the
  // param its own pagination links use. It silently ignores `?page=N` and
  // serves page 1 again, so a wrong template doesn't fail: it re-imports the
  // first 32 bikes once per page and never reaches the other 576.
  it('ebikeshop config paginates on the query param the site actually reads', () => {
    const config = ebikeshopConfig as unknown as ScrapingSourceConfig;
    expect(config.listPage.pagination?.urlTemplate).toBe(
      '{{startUrl}}?oldal={{page}}',
    );
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

  it('speedbike config enables LLM post-processing', () => {
    const config = speedbikeConfig as unknown as ScrapingSourceConfig;
    expect(config.detailPage.postProcess?.enabled).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EVERY LIVE CONFIG IS CURRENTLY CAPPED AT 10 ITEMS FOR TESTING.
  //
  // This test exists to make that impossible to forget. It is not describing a
  // property worth preserving — it is a tripwire. Before any real catalogue
  // run, remove `maxItems` from these configs and delete this test with it;
  // otherwise a source that looks fully configured will import ten products
  // and stop, and nothing else will say why.
  // ─────────────────────────────────────────────────────────────────────────
  it.each([
    ['ebikeshop', ebikeshopConfig],
    ['speedbike', speedbikeConfig],
    ['speedbike-arukereso', speedbikeArukeresoConfig],
    ['speedbike-googleshop', speedbikeGoogleshopConfig],
  ])('%s is capped at 10 items — REMOVE BEFORE A REAL RUN', (_name, config) => {
    expect((config as { maxItems?: number }).maxItems).toBe(10);
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
        pipeline: [
          { op: 'mapValue', cases: { NO: 'out_of_stock' }, default: 'in_stock' },
        ],
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
    it('turns the LLM post-processing off', () => {
      expect(config.postProcess).toEqual({ enabled: false });
    });
  });
});
