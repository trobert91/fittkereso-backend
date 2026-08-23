import { ProductSourceConfig, ScrapeOperation } from '@fittkereso-backend/database';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { registerOps } from '../ops/register-ops';
import ebikeshopConfig from './ebikeshop.config.json';
import speedbikeConfig from './speedbike.config.json';

// Structural/registry validation of the hand-authored production configs —
// not a live-site test, but catches typos in op names, missing required
// pipeline sections, and structurally invalid JSON before these configs are
// seeded as ProductSource.config rows in Phase 4.
describe('hand-authored source configs', () => {
  let registry: ScrapeOpRegistryService;

  beforeAll(() => {
    registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());
  });

  function collectOpNames(value: unknown, names: Set<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) collectOpNames(item, names);
      return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj['op'] === 'string') {
        names.add(obj['op']);
      }
      for (const key of Object.keys(obj)) {
        collectOpNames(obj[key], names);
      }
    }
  }

  function assertConfigValid(config: ProductSourceConfig, label: string) {
    expect(config.baseUrl).toEqual(expect.any(String));
    expect(config.listPage).toBeDefined();
    expect(config.detailPage).toBeDefined();
    expect(config.detailPage.rawSpecs).toBeDefined();
    expect(config.detailPage.category.slugLookup.length).toBeGreaterThan(0);

    const opNames = new Set<string>();
    collectOpNames(config, opNames);
    for (const name of opNames) {
      expect(() => registry.get(name as ScrapeOperation['op'])).not.toThrow(
        `${label}: unknown op "${name}"`,
      );
    }
  }

  it('validates the ebikeshop config against the op registry', () => {
    assertConfigValid(ebikeshopConfig as unknown as ProductSourceConfig, 'ebikeshop');
  });

  it('validates the speedbike config against the op registry', () => {
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
