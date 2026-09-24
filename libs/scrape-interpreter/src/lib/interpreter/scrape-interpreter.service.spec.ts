import * as cheerio from 'cheerio';
import { ScrapingSourceConfig, ProductImportTask } from '@fittkereso-backend/database';
import { ScrapeInterpreterService } from './scrape-interpreter.service';
import { ScrapePipelineRunnerService } from './services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from './services/scrape-op-registry.service';
import { RuntimeDataProviderService } from './services/runtime-data-provider.service';
import { ProductValueMapperService } from './services/product-value-mapper.service';
import { registerOps } from './ops/register-ops';

function makeTask(url = 'https://www.arukereso.hu/monitorok/asus-pg34-p12345/'): ProductImportTask {
  return { id: 'task-1', url } as ProductImportTask;
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
    it('extracts the category name and one ScrapedListProduct per card', async () => {
      const html = `
        <h1 class="category-title">Monitor</h1>
        <div class="list-view">
          <div class="product-box">
            <a class="name" href="/asus-pg34-p123">ASUS PG34</a>
            <span class="price">129 900 Ft</span>
          </div>
          <div class="product-box">
            <a class="name" href="/dell-u2720-p456">Dell U2720</a>
            <span class="price">99 900 Ft</span>
          </div>
        </div>
      `;
      const $ = cheerio.load(html);

      const config: ScrapingSourceConfig = {
        baseUrl: 'https://www.arukereso.hu',
        startUrls: ['https://www.arukereso.hu/monitorok'],
        listPage: {
          categoryName: [
            { op: 'selectText', selector: 'h1.category-title', first: true, trim: true },
          ],
          items: [{ op: 'selectAll', selector: '.product-box' }],
          itemMode: 'cheerio',
          itemPipeline: [
            {
              op: 'assembleListProduct',
              url: [
                {
                  op: 'selectAttr',
                  selector: 'a.name',
                  attr: 'href',
                  within: 'item',
                  first: true,
                },
              ],
              name: [
                { op: 'selectFirst', selector: 'a.name', within: 'item' },
                { op: 'selectText', trim: true },
              ],
              price: [
                { op: 'selectFirst', selector: '.price', within: 'item' },
                { op: 'selectText', trim: true },
                { op: 'stripPattern', pattern: '[^0-9]', flags: 'g' },
                { op: 'jsonPath', cast: 'number' },
              ],
              currency: [{ op: 'literal', value: 'HUF' }],
            },
          ],
        },
        detailPage: {
          rawSpecs: [],
          category: { breadcrumbOrSource: [], slugLookup: [{ when: { always: true }, slug: 'monitors' }] },
          brand: [],
          model: [],
          images: [],
          specMapping: {},
        },
      };

      const result = await interpreter.runListPage(makeTask(), $, config);

      expect(result.categoryName).toBe('Monitor');
      expect(result.products).toEqual([
        {
          url: '/asus-pg34-p123',
          name: 'ASUS PG34',
          price: 129900,
          currency: 'HUF',
          externalId: undefined,
          priceWithoutDiscount: undefined,
          availability: undefined,
        },
        {
          url: '/dell-u2720-p456',
          name: 'Dell U2720',
          price: 99900,
          currency: 'HUF',
          externalId: undefined,
          priceWithoutDiscount: undefined,
          availability: undefined,
        },
      ]);
    });

    // A card that yields no URL cannot be matched to a stored listing, so it
    // can neither refresh an offer nor be enqueued for a detail scrape.
    it('drops cards that yield no URL', async () => {
      const html = `
        <div class="list-view">
          <div class="product-box"><a class="name" href="/real-p1">Real</a></div>
          <div class="product-box"><span>no anchor here</span></div>
        </div>
      `;
      const $ = cheerio.load(html);

      const config: ScrapingSourceConfig = {
        baseUrl: 'https://www.arukereso.hu',
        startUrls: ['https://www.arukereso.hu/monitorok'],
        listPage: {
          categoryName: [],
          items: [{ op: 'selectAll', selector: '.product-box' }],
          itemMode: 'cheerio',
          itemPipeline: [
            {
              op: 'assembleListProduct',
              url: [
                {
                  op: 'selectAttr',
                  selector: 'a.name',
                  attr: 'href',
                  within: 'item',
                  first: true,
                },
              ],
            },
          ],
        },
        detailPage: {
          rawSpecs: [],
          category: { breadcrumbOrSource: [], slugLookup: [{ when: { always: true }, slug: 'monitors' }] },
          brand: [],
          model: [],
          images: [],
          specMapping: {},
        },
      };

      const result = await interpreter.runListPage(makeTask(), $, config);

      expect(result.products).toEqual([{
        url: '/real-p1',
        name: undefined,
        price: undefined,
        currency: undefined,
        externalId: undefined,
        priceWithoutDiscount: undefined,
        availability: undefined,
      }]);
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

      const config: ScrapingSourceConfig = {
        baseUrl: 'https://www.arukereso.hu',
        startUrls: ['https://www.arukereso.hu/monitorok'],
        listPage: { categoryName: [], items: [], itemMode: 'cheerio', itemPipeline: [] },
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
      ): ScrapingSourceConfig => ({
        baseUrl: 'https://www.arukereso.hu',
        startUrls: ['https://www.arukereso.hu/monitorok'],
        listPage: { categoryName: [], items: [], itemMode: 'cheerio', itemPipeline: [] },
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
      } as unknown as ScrapingSourceConfig);

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
        } as unknown as ProductImportTask;
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

  describe('runDetailPage offers', () => {
    const baseDetailPage = () => ({
      rawSpecs: [],
      category: {
        breadcrumbOrSource: [],
        slugLookup: [{ when: { always: true } as const, slug: 'ebikes' }],
      },
      brand: [{ op: 'identity' as const, value: undefined }],
      model: [{ op: 'identity' as const, value: undefined }],
      images: [],
      specMapping: {},
    });

    it('extracts a single self-offer when offerList resolves to one item and price resolves', async () => {
      const $ = cheerio.load(`
        <div id="app" data-page='{"props":{"product":{"stocks":[{"inStock":true}],"prices":{"price":3879000},"productCode":"1260040108"}}}'></div>
      `);

      const config: ScrapingSourceConfig = {
        baseUrl: 'https://ebikeshop.hu',
        startUrls: ['https://ebikeshop.hu/termekek'],
        listPage: { categoryName: [], items: [], itemMode: 'cheerio', itemPipeline: [] },
        detailPage: {
          ...baseDetailPage(),
          offers: {
            // A genuine 1-element array, mirroring the real ebikeshop.hu
            // config's offerList (props.product.stocks) — offerList must
            // resolve to an actual array fed to forEachItem, not a scalar
            // (a plain string would incorrectly iterate its characters).
            offerList: [
              {
                op: 'parseJsonAttr',
                selector: '#app',
                attr: 'data-page',
                path: 'props.product.stocks',
              } as never,
            ],
            itemMode: 'json',
            itemPipeline: [
              {
                op: 'assembleOffer',
                price: [
                  {
                    op: 'parseJsonAttr',
                    selector: '#app',
                    attr: 'data-page',
                    path: 'props.product.prices.price',
                  } as never,
                ],
                currency: [{ op: 'literal', value: 'HUF' } as never],
                externalId: [
                  {
                    op: 'parseJsonAttr',
                    selector: '#app',
                    attr: 'data-page',
                    path: 'props.product.productCode',
                  } as never,
                ],
              } as never,
            ],
          },
        },
      };

      const result = await interpreter.runDetailPage(makeTask(), $, config);

      expect(result.rawOffers).toEqual([
        {
          price: 3879000,
          priceWithoutDiscount: undefined,
          currency: 'HUF',
          availability: undefined,
          url: undefined,
          externalId: '1260040108',
          specs: undefined,
        },
      ]);
    });

    it('returns no offers when offers config is absent', async () => {
      const $ = cheerio.load('<div></div>');
      const config: ScrapingSourceConfig = {
        baseUrl: 'https://ebikeshop.hu',
        startUrls: ['https://ebikeshop.hu/termekek'],
        listPage: { categoryName: [], items: [], itemMode: 'cheerio', itemPipeline: [] },
        detailPage: baseDetailPage(),
      };

      const result = await interpreter.runDetailPage(makeTask(), $, config);
      expect(result.rawOffers).toEqual([]);
    });

    it('returns no offers when price fails to resolve to a number', async () => {
      const $ = cheerio.load(`
        <div id="app" data-page='{"props":{"stocks":[{"inStock":true}]}}'></div>
      `);
      const config: ScrapingSourceConfig = {
        baseUrl: 'https://ebikeshop.hu',
        startUrls: ['https://ebikeshop.hu/termekek'],
        listPage: { categoryName: [], items: [], itemMode: 'cheerio', itemPipeline: [] },
        detailPage: {
          ...baseDetailPage(),
          offers: {
            offerList: [
              {
                op: 'parseJsonAttr',
                selector: '#app',
                attr: 'data-page',
                path: 'props.stocks',
              } as never,
            ],
            itemMode: 'json',
            itemPipeline: [
              {
                op: 'assembleOffer',
                price: [{ op: 'identity', value: undefined } as never],
              } as never,
            ],
          },
        },
      };

      const result = await interpreter.runDetailPage(makeTask(), $, config);
      expect(result.rawOffers).toEqual([]);
    });

    it('extracts one distinct offer per item on a genuine multi-item offer list', async () => {
      const $ = cheerio.load(`
        <div class="variant-row">
          <span class="variant-price">120000</span>
        </div>
        <div class="variant-row">
          <span class="variant-price">115000</span>
        </div>
        <div class="variant-row">
          <span class="variant-price">130000</span>
        </div>
      `);

      const config: ScrapingSourceConfig = {
        baseUrl: 'https://aggregator.example',
        startUrls: ['https://aggregator.example/list'],
        listPage: { categoryName: [], items: [], itemMode: 'cheerio', itemPipeline: [] },
        detailPage: {
          ...baseDetailPage(),
          offers: {
            offerList: [{ op: 'selectAll', selector: '.variant-row' } as never],
            itemMode: 'cheerio',
            itemPipeline: [
              {
                op: 'assembleOffer',
                // selectNestedText takes the forEachItem-piped single-element
                // selection as its `input` (index 0 into it) and searches
                // *within* it via childSelector — genuinely scoped per item,
                // unlike selectText/selectAttr (which always query the whole
                // document regardless of any piped input).
                price: [
                  {
                    op: 'selectNestedText',
                    index: 0,
                    childSelector: '.variant-price',
                    trim: true,
                  } as never,
                ],
              } as never,
            ],
          },
        },
      };

      const result = await interpreter.runDetailPage(makeTask(), $, config);

      expect(result.rawOffers.map((o) => o.price)).toEqual([
        120000, 115000, 130000,
      ]);
    });
  });
});
