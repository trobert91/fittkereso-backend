import * as cheerio from 'cheerio';
import { ProductSourceConfig, ScrapeTask } from '@fittkereso-backend/database';
import { ScrapeInterpreterService } from './scrape-interpreter.service';
import { ScrapePipelineRunnerService } from './services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from './services/scrape-op-registry.service';
import { RuntimeDataProviderService } from './services/runtime-data-provider.service';
import { ProductValueMapperService } from './services/product-value-mapper.service';
import { registerOps } from './ops/register-ops';

function makeTask(url = 'https://www.arukereso.hu/monitorok/asus-pg34-p12345/'): ScrapeTask {
  return { id: 'task-1', url } as ScrapeTask;
}

describe('ScrapeInterpreterService', () => {
  let interpreter: ScrapeInterpreterService;
  let runtime: jest.Mocked<RuntimeDataProviderService>;

  beforeEach(() => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    const valueMapper = new ProductValueMapperService();
    runtime = {
      getBrandNames: jest.fn().mockResolvedValue(['ASUS', 'Logitech']),
      getCategoryBySlug: jest.fn(),
    } as unknown as jest.Mocked<RuntimeDataProviderService>;

    registerOps(registry, runner, valueMapper);
    interpreter = new ScrapeInterpreterService(runner, runtime);
  });

  describe('runListPage', () => {
    it('extracts category name, product links filtered by brand prefix, and pagination links', async () => {
      const html = `
        <h1 class="category-title">Monitor</h1>
        <div class="category-navbar"><span class="product-num">51 termék, 1. oldal</span></div>
        <div class="list-view">
          <div class="product-box" data-akpid="123">
            <a href="/asus-pg34-p123" title="ASUS PG34"></a>
          </div>
          <div class="product-box" data-akpid="456">
            <a href="/unknown-brand-p456" title="UnknownBrand X1"></a>
          </div>
          <div class="product-box" data-akpid="789-PADS">
            <a href="/asus-pads-p789" title="ASUS Pads"></a>
          </div>
        </div>
      `;
      const $ = cheerio.load(html);

      const config: ProductSourceConfig = {
        baseUrl: 'https://www.arukereso.hu',
        listPage: {
          categoryName: [
            { op: 'selectText', selector: 'h1.category-title', first: true, trim: true },
          ],
          categoryLinks: [
            {
              op: 'selectText',
              selector: '.category-navbar .product-num',
              trim: true,
              as: 'productNumText',
            },
            {
              op: 'assertContains',
              value: 'productNumText',
              substring: ', 1. oldal',
              onFail: 'returnEmpty',
            },
            {
              op: 'regexCapture',
              value: 'productNumText',
              pattern: '(\\d+)\\s*termék',
              group: 1,
              cast: 'number',
              as: 'totalProducts',
            },
            { op: 'computePages', totalItems: 'totalProducts', perPage: 25, as: 'totalPages' },
            {
              op: 'buildBaseUrl',
              from: 'task.url',
              stripQuery: true,
              trimTrailingSlash: true,
              as: 'baseUrl',
            },
            {
              op: 'generatePaginationLinks',
              totalPages: 'totalPages',
              startPage: 2,
              baseUrl: 'baseUrl',
              urlTemplate: '{baseUrl}/?start={(page-1)*25}',
              titleTemplate: 'Page {page}',
            },
          ],
          productLinks: [
            { op: 'selectAll', selector: '.list-view .product-box', as: 'boxes' },
            { op: 'filterByAttrAbsent', on: 'boxes', attr: 'data-akpid', as: 'boxes' },
            {
              op: 'filterByAttrSuffix',
              on: 'boxes',
              attr: 'data-akpid',
              excludeSuffix: '-PADS',
              as: 'boxes',
            },
            {
              op: 'extractLinkFromBox',
              on: 'boxes',
              linkSelector: 'a',
              first: true,
              titleFrom: ['attr:title', 'text'],
            },
            {
              op: 'filterByBrandPrefix',
              source: 'runtime:brandCache',
              field: 'title',
              caseInsensitive: true,
            },
          ],
        },
        detailPage: {
          rawSpecs: [],
          category: { breadcrumbOrSource: [], slugLookup: [] },
          brand: [],
          model: [],
          images: [],
          specMapping: {},
        },
      };

      const result = await interpreter.runListPage(makeTask(), $, config);

      expect(result.categoryName).toBe('Monitor');
      expect(result.productLinks).toEqual([
        { url: '/asus-pg34-p123', title: 'ASUS PG34' },
      ]);
      expect(result.categoryLinks).toEqual([
        {
          url: 'https://www.arukereso.hu/monitorok/asus-pg34-p12345/?start=25',
          title: 'Page 2',
        },
        {
          url: 'https://www.arukereso.hu/monitorok/asus-pg34-p12345/?start=50',
          title: 'Page 3',
        },
      ]);
    });
  });

  describe('runDetailPage', () => {
    it('resolves brand/model from an embedded dataLayerHG script and picks the V1 spec table', async () => {
      const html = `
        <script>
          var dataLayerHG = { "item_brand": "ASUS", "item_name": "ASUS ROG Swift PG34WCDM (90LM0930-B01170)" };
        </script>
        <table class="product-properties">
          <tr><td class="prop-name"><h3>General</h3></td><td></td></tr>
          <tr><td class="prop-name">Screen size</td><td>34"</td></tr>
        </table>
        <meta itemprop="description" content="A great monitor" />
      `;
      const $ = cheerio.load(html);

      const config: ProductSourceConfig = {
        baseUrl: 'https://www.arukereso.hu',
        listPage: { categoryName: [], categoryLinks: [], productLinks: [] },
        detailPage: {
          rawSpecs: [
            {
              op: 'extractSpecTableV1',
              rowSelector: 'table.product-properties tr',
              sectionHeaderSelector: 'h3',
              nameSelector: 'td.prop-name',
              nameExcludeChildren: true,
              valueCellIndex: 1,
              listValueSelector: '.prop .name',
              descriptionSelector: '.hint',
              descriptionAttr: 'data-content',
              dedupeBy: 'name',
            },
          ],
          category: {
            breadcrumbOrSource: [{ op: 'identity' }],
            slugLookup: [{ when: { always: true }, slug: 'monitors' }],
          },
          brand: [
            { op: 'selectAll', selector: 'script', as: 'scripts' },
            {
              op: 'findScriptContaining',
              on: 'scripts',
              contains: 'dataLayerHG',
              as: 'dataLayerJson',
            },
            {
              op: 'regexCapture',
              value: 'dataLayerJson',
              pattern: '"item_brand"\\s*:\\s*"([^"]+)"',
              group: 1,
              trim: true,
            },
          ],
          model: [
            {
              op: 'regexCapture',
              value: 'dataLayerJson',
              pattern: '"item_name"\\s*:\\s*"([^"]+)"',
              group: 1,
              trim: true,
              as: 'fullModelText',
            },
            { op: 'stripPrefix', value: 'fullModelText', prefix: '{{brand}}' },
            {
              op: 'stripPattern',
              pattern: '\\s*\\([A-Za-z0-9][A-Za-z0-9\\-/]*(?:-[A-Za-z0-9]+|[0-9])[A-Za-z0-9\\-/]*\\)',
              flags: 'g',
              trim: true,
            },
          ],
          images: [],
          specMapping: {},
        },
      };

      const result = await interpreter.runDetailPage(makeTask(), $, config);

      expect(result.brand).toBe('ASUS');
      expect(result.model).toBe('ROG Swift PG34WCDM');
      expect(result.categorySlug).toBe('monitors');
      expect(result.rawSpecs).toEqual([
        {
          sectionTitle: 'General',
          name: 'Screen size',
          description: undefined,
          values: ['34"'],
        },
      ]);
    });

    it('resolves headphones vs headsets via a specValueIncludes rule with unless', async () => {
      const $ = cheerio.load('<div></div>');

      // Mirrors ArukeresoCategoryMapperService.resolveHeadphonesOrHeadsets:
      // default to headphones unless the "Típus" spec explicitly reads as a
      // headset/gaming-headset shape, in which case route to headsets.
      const slugLookup = [
        {
          when: { equalsIgnoreCase: 'fülhallgató, fejhallgató' },
          slug: 'headphones' as const,
          unless: {
            specValueIncludes: {
              label: 'Típus',
              anyOf: ['headset', 'gamer'],
            },
          },
        },
        {
          when: { equalsIgnoreCase: 'fülhallgató, fejhallgató' },
          slug: 'headsets' as const,
        },
      ];

      // A stub registry lets rawSpecs/breadcrumbOrSource return fixed test
      // fixtures directly, isolating the category-resolution logic under
      // test from the rest of the (already-covered) op vocabulary.
      const buildConfig = (
        specs: { name: string; values: string[] }[],
      ): ProductSourceConfig => ({
        baseUrl: 'https://www.arukereso.hu',
        listPage: { categoryName: [], categoryLinks: [], productLinks: [] },
        detailPage: {
          rawSpecs: [{ op: 'returnFixture', fixture: 'specs' } as never],
          category: {
            breadcrumbOrSource: [
              { op: 'returnFixture', fixture: 'breadcrumb' } as never,
            ],
            slugLookup,
          },
          brand: [],
          model: [],
          images: [],
          specMapping: {},
        },
        __fixtures: { specs, breadcrumb: 'fülhallgató, fejhallgató' },
      } as unknown as ProductSourceConfig);

      const stubRegistry = new ScrapeOpRegistryService();
      const stubRunner = new ScrapePipelineRunnerService(stubRegistry);
      stubRegistry.register('returnFixture' as never, (ctx, _input, op: any) => {
        const fixtures = (ctx.task as any).__fixtures;
        return fixtures[op.fixture];
      });
      const stubInterpreter = new ScrapeInterpreterService(
        stubRunner,
        runtime,
      );

      const runWithSpecs = (specs: { name: string; values: string[] }[]) => {
        const config = buildConfig(specs);
        const task = {
          ...makeTask(),
          __fixtures: (config as any).__fixtures,
        } as unknown as ScrapeTask;
        return stubInterpreter.runDetailPage(task, $, config);
      };

      const headphoneResult = await runWithSpecs([
        { name: 'Típus', values: ['fülhallgató'] },
      ]);
      expect(headphoneResult.categorySlug).toBe('headphones');

      const headsetResult = await runWithSpecs([
        { name: 'Típus', values: ['gamer headset'] },
      ]);
      expect(headsetResult.categorySlug).toBe('headsets');
    });
  });

  describe('classifyIncrementalUrl', () => {
    it('routes a matching URL to ScrapeProductDetails', () => {
      const config: ProductSourceConfig = {
        baseUrl: 'https://www.arukereso.hu',
        incrementalSync: {
          urlClassify: { detailUrlPattern: 'arukereso\\.hu\\/.+-p\\d+\\/?' },
        },
        listPage: { categoryName: [], categoryLinks: [], productLinks: [] },
        detailPage: {
          rawSpecs: [],
          category: { breadcrumbOrSource: [], slugLookup: [] },
          brand: [],
          model: [],
          images: [],
          specMapping: {},
        },
      };

      const result = interpreter.classifyIncrementalUrl(
        'https://www.arukereso.hu/monitorok/asus-pg34-p12345/',
        config,
      );

      expect(result).toEqual({
        queue: 'scrape-product-details',
        url: 'https://www.arukereso.hu/monitorok/asus-pg34-p12345/',
      });
    });

    it('returns null for a non-matching URL', () => {
      const config: ProductSourceConfig = {
        baseUrl: 'https://www.arukereso.hu',
        incrementalSync: {
          urlClassify: { detailUrlPattern: 'arukereso\\.hu\\/.+-p\\d+\\/?' },
        },
        listPage: { categoryName: [], categoryLinks: [], productLinks: [] },
        detailPage: {
          rawSpecs: [],
          category: { breadcrumbOrSource: [], slugLookup: [] },
          brand: [],
          model: [],
          images: [],
          specMapping: {},
        },
      };

      const result = interpreter.classifyIncrementalUrl(
        'https://www.arukereso.hu/monitorok/',
        config,
      );

      expect(result).toBeNull();
    });
  });
});
