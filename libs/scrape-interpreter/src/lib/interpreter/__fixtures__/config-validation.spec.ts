import {
  ProductSourceConfig,
  ProductSourceConfigValidatorService,
} from '@fittkereso-backend/database';
import ebikeshopConfig from './ebikeshop.config.json';
import speedbikeConfig from './speedbike.config.json';

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

  function assertConfigValid(config: ProductSourceConfig, label: string) {
    const problems = validator.problems(config);

    // Rendered into the failure message rather than asserted as `toBeNull()`:
    // a bare "expected null, got [object Object]" would make somebody re-run
    // this by hand to find out which path was wrong.
    expect(problems ? `${label}: ${validator.format(problems)}` : null).toBeNull();
  }

  it('validates the ebikeshop config against the config schema', () => {
    assertConfigValid(ebikeshopConfig as unknown as ProductSourceConfig, 'ebikeshop');
  });

  it('validates the speedbike config against the config schema', () => {
    assertConfigValid(speedbikeConfig as unknown as ProductSourceConfig, 'speedbike');
  });

  it('ebikeshop config resolves every product to the single ebikes category', () => {
    const config = ebikeshopConfig as unknown as ProductSourceConfig;
    expect(config.detailPage.category.slugLookup).toEqual([
      { when: { always: true }, slug: 'ebikes' },
    ]);
  });

  it('speedbike config resolves E-BIKE breadcrumb text to the ebikes category', () => {
    const config = speedbikeConfig as unknown as ProductSourceConfig;
    expect(config.detailPage.category.slugLookup).toEqual([
      { when: { equalsIgnoreCase: 'E-BIKE' }, slug: 'ebikes' },
    ]);
  });

  it('speedbike config enables LLM post-processing', () => {
    const config = speedbikeConfig as unknown as ProductSourceConfig;
    expect(config.detailPage.postProcess?.enabled).toBe(true);
  });

  it('ebikeshop config has no postProcess override, so it picks up the on-by-default behavior', () => {
    expect(
      (ebikeshopConfig as unknown as ProductSourceConfig).detailPage.postProcess,
    ).toBeUndefined();
  });
});
