import { ProductSourceConfig, ScrapeOperation } from '@fittkereso-backend/database';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { registerOps } from '../ops/register-ops';
import arukeresoConfig from './arukereso.config.json';
import displayspecsConfig from './displayspecs.config.json';
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

  it('validates the Arukereso config against the op registry', () => {
    assertConfigValid(arukeresoConfig as unknown as ProductSourceConfig, 'arukereso');
  });

  it('validates the DisplaySpecs config against the op registry', () => {
    assertConfigValid(
      displayspecsConfig as unknown as ProductSourceConfig,
      'displayspecs',
    );
  });

  it('validates the ebikeshop config against the op registry', () => {
    assertConfigValid(ebikeshopConfig as unknown as ProductSourceConfig, 'ebikeshop');
  });

  it('validates the speedbike config against the op registry', () => {
    assertConfigValid(speedbikeConfig as unknown as ProductSourceConfig, 'speedbike');
  });

  it('Arukereso config resolves all 15 category slugLookup rules to distinct slugs (headphones covered twice by design)', () => {
    const config = arukeresoConfig as unknown as ProductSourceConfig;
    const slugs = config.detailPage.category.slugLookup.map((r) => r.slug);
    expect(slugs).toEqual([
      'monitors',
      'action-cameras',
      'portable-bluetooth-speakers',
      'ip-cameras',
      'headphones',
      'headsets',
      'keyboards',
      'mice',
      'projectors',
      'robot-vacuums',
      'smartwatches-fitness-trackers',
      'soundbars',
      'internal-ssds',
      'tvs',
      'wifi-routers',
    ]);
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

  it('DisplaySpecs config resolves TV vs monitor via specSectionTitleIn with a monitor fallback', () => {
    const config = displayspecsConfig as unknown as ProductSourceConfig;
    expect(config.detailPage.category.slugLookup).toEqual([
      {
        when: {
          specSectionTitleIn: [
            'Video file formats',
            'Audio file formats',
            'TV tuner',
          ],
        },
        slug: 'tvs',
      },
      { when: { always: true }, slug: 'monitors' },
    ]);
  });
});
