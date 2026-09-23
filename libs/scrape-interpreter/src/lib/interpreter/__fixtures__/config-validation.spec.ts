import {
  ArukeresoSourceConfig,
  ProductSourceConfig,
  ProductSourceType,
  ScrapingSourceConfig,
  ProductSourceConfigValidatorService,
} from '@fittkereso-backend/database';
import ebikeshopConfig from './ebikeshop.config.json';
import speedbikeConfig from './speedbike.config.json';
import speedbikeArukeresoConfig from './speedbike-arukereso.config.json';

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

    // The feed's attribute_name values are the same labels the shop's own spec
    // table uses, which is what makes a feed source cheap to add for a shop
    // that was already scraped.
    it('reuses the scraping source spec mappings unchanged', () => {
      expect(config.specMapping?.['ebikes']).toEqual(
        (speedbikeConfig as unknown as ScrapingSourceConfig).detailPage
          .specMapping['ebikes'],
      );
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
});
