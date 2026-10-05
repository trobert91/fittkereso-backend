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
          category: { breadcrumbOrSource: [] },
          brand: [],
          model: [],
          images: [],
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
          category: { breadcrumbOrSource: [] },
          brand: [],
          model: [],
          images: [],
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
        categories: { monitors: { enabled: true, rules: [{ when: { always: true } }] } },
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

    describe('category sections', () => {
      // Rows are passed straight in, isolating the category resolution from
      // the rest of the (already-covered) op vocabulary.
      const label = 'fülhallgató, fejhallgató';
      const headset = {
        specValueIncludes: { label: 'Típus', anyOf: ['headset', 'gamer'] },
      };
      const resolve = (
        categories: ScrapingSourceConfig['categories'],
        values: string[],
      ) => interpreter.resolveCategory(categories, label, [{ name: 'Típus', values }]);

      // Mirrors ArukeresoCategoryMapperService.resolveHeadphonesOrHeadsets:
      // headphones, unless the "Típus" spec reads as a headset.
      const headphonesOrHeadsets = {
        headphones: {
          enabled: true,
          rules: [{ when: { equalsIgnoreCase: label }, unless: headset }],
        },
        headsets: { enabled: true, rules: [{ when: headset }] },
      };

      it('resolves headphones vs headsets via a specValueIncludes rule with unless', () => {
        expect(resolve(headphonesOrHeadsets, ['fülhallgató'])).toEqual({
          status: 'resolved',
          slug: 'headphones',
        });
        expect(resolve(headphonesOrHeadsets, ['gamer headset'])).toEqual({
          status: 'resolved',
          slug: 'headsets',
        });
      });

      // No section is a fallback for another: a listing that two claim is
      // reported, not given to whichever comes first.
      it('reports a listing whose rules match in two sections as ambiguous', () => {
        const overlapping = {
          ...headphonesOrHeadsets,
          headsets: { enabled: true, rules: [{ when: { equalsIgnoreCase: label } }] },
        };
        expect(resolve(overlapping, ['fülhallgató'])).toEqual({
          status: 'ambiguous',
          slugs: ['headphones', 'headsets'],
        });
      });

      // A disabled section still claims its listings, so the caller can skip
      // them as not enabled rather than not recognised.
      it('resolves to a disabled section too, and matches nothing without rules', () => {
        expect(
          resolve({ headphones: { enabled: false, rules: [{ when: { always: true } }] } }, []),
        ).toEqual({ status: 'resolved', slug: 'headphones' });
        expect(resolve({ headphones: { enabled: true } }, [])).toEqual({
          status: 'unidentified',
        });
      });

      it('gives the detail page its category, or the slugs that both claim it', async () => {
        const $ = cheerio.load('<div></div>');
        const page = (categories: ScrapingSourceConfig['categories']): ScrapingSourceConfig => ({
          baseUrl: 'https://www.arukereso.hu',
          startUrls: ['https://www.arukereso.hu/monitorok'],
          categories,
          listPage: { categoryName: [], items: [], itemMode: 'cheerio', itemPipeline: [] },
          detailPage: {
            rawSpecs: [],
            category: { breadcrumbOrSource: [{ op: 'literal', value: label }] },
            brand: [],
            model: [],
            images: [],
          },
        });

        const single = await interpreter.runDetailPage(makeTask(), $, page(headphonesOrHeadsets));
        expect(single.categorySlug).toBe('headphones');
        expect(single.ambiguousCategorySlugs).toBeUndefined();

        const both = await interpreter.runDetailPage(
          makeTask(),
          $,
          page({
            headphones: { enabled: true, rules: [{ when: { always: true } }] },
            headsets: { enabled: true, rules: [{ when: { always: true } }] },
          }),
        );
        expect(both.categorySlug).toBeUndefined();
        expect(both.ambiguousCategorySlugs).toEqual(['headphones', 'headsets']);
      });
    });
  });

  describe('runDetailPage offers', () => {
    const baseDetailPage = () => ({
      rawSpecs: [],
      category: { breadcrumbOrSource: [] },
      brand: [{ op: 'identity' as const, value: undefined }],
      model: [{ op: 'identity' as const, value: undefined }],
      images: [],
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
