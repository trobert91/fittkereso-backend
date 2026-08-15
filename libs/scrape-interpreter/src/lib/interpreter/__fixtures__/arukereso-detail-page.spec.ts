import * as cheerio from 'cheerio';
import { ProductSourceConfig, ScrapeTask } from '@fittkereso-backend/database';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
import arukeresoConfig from './arukereso.config.json';

// Golden-fixture regression test: this HTML mirrors the real DOM shapes
// ArukeresoDetailsPageExtractor (V1 layout) was written against — a
// dataLayerHG script tag, breadcrumb trail, product-properties spec table
// with a section header, an SKU-parenthetical + country-code suffix in the
// h1 fallback text, and a carousel image layout. Every field asserted below
// was independently verified against the original extractor's source before
// deletion, per the plan's "dual-path diff" validation step (section 9).
const ARUKERESO_DETAIL_HTML = `
  <div class="breadcrumb-field">
    <span itemprop="itemListElement"><span itemprop="name">Home</span></span>
    <span itemprop="itemListElement"><span itemprop="name">Electronics</span></span>
    <span itemprop="itemListElement"><span itemprop="name">Monitor</span></span>
    <span itemprop="itemListElement"><span itemprop="name">ASUS Monitor</span></span>
  </div>
  <script>
    var dataLayerHG = { "item_brand": "ASUS", "item_name": "ASUS ROG Swift PG34WCDM (90LM0930-B01170) HU" };
  </script>
  <div class="product-page-top">
    <h1 class="hidden-xs">ASUS ROG Swift PG34WCDM (90LM0930-B01170) HU</h1>
  </div>
  <table class="product-properties">
    <tr><td class="prop-name"><h3>Kijelző</h3></td><td></td></tr>
    <tr><td class="prop-name">Képátló</td><td>34"</td></tr>
    <tr><td class="prop-name">Csatlakozók</td><td><div class="prop"><div class="name">HDMI</div></div><div class="prop"><div class="name">DisplayPort</div></div></td></tr>
  </table>
  <meta itemprop="description" content="Kiváló minőségű monitor." />
  <div class="carousel-inner">
    <img data-lazy-delayed-src="https://akcdn.net/full/pg34wcdm-1.jpg" />
    <img data-lazy-delayed-src="https://akcdn.net/full/pg34wcdm-2.jpg" />
  </div>
`;

function makeTask(): ScrapeTask {
  return {
    id: 'task-1',
    url: 'https://www.arukereso.hu/monitorok/asus/asus-rog-swift-pg34wcdm-p987654321/',
  } as ScrapeTask;
}

describe('Arukereso detail page — declarative config golden fixture', () => {
  let interpreter: ScrapeInterpreterService;

  beforeEach(() => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());

    const runtime: RuntimeDataProvider = {
      getBrandNames: jest.fn().mockResolvedValue(['ASUS']),
      getCategoryBySlug: jest.fn(),
    };

    interpreter = new ScrapeInterpreterService(
      runner,
      runtime as never,
    );
  });

  it('reproduces brand/model/category/specs/images exactly as ArukeresoDetailsPageExtractor did', async () => {
    const $ = cheerio.load(ARUKERESO_DETAIL_HTML);
    const config = arukeresoConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    // Brand: dataLayerHG wins over breadcrumb fallback.
    expect(result.brand).toBe('ASUS');

    // Model: dataLayerHG item_name, brand-prefix stripped, SKU-parenthetical
    // stripped, trailing "HU" country-code suffix stripped — matches
    // ArukeresoDetailsPageExtractor's exact three-step regex pipeline.
    expect(result.model).toBe('ROG Swift PG34WCDM');

    // Category: breadcrumb index 2 ("Monitor") resolves via the first
    // equalsIgnoreCase slugLookup rule.
    expect(result.categorySlug).toBe('monitors');

    // Raw specs: V1 table branch taken (table.product-properties present),
    // section header captured, list-style connector values collected,
    // synthetic description spec appended from the meta tag.
    expect(result.rawSpecs).toEqual([
      {
        sectionTitle: 'Kijelző',
        name: 'Képátló',
        description: undefined,
        values: ['34"'],
      },
      {
        sectionTitle: 'Kijelző',
        name: 'Csatlakozók',
        description: undefined,
        values: ['HDMI', 'DisplayPort'],
      },
      {
        name: 'description',
        values: ['Kiváló minőségű monitor.'],
      },
    ]);

    // Images: V1 carousel layout, first image only kept (mainImageUrl slot).
    expect(result.imageUrls).toEqual(['https://akcdn.net/full/pg34wcdm-1.jpg']);
  });

  it('falls back to the V2 property-sheet table when product-properties is absent', async () => {
    const html = `
      <div class="breadcrumb-field">
        <span itemprop="itemListElement"><span itemprop="name">Home</span></span>
        <span itemprop="itemListElement"><span itemprop="name">Electronics</span></span>
        <span itemprop="itemListElement"><span itemprop="name">Egér</span></span>
      </div>
      <table class="property-sheet">
        <tr class="property-title"><td>Alapadatok</td></tr>
        <tr>
          <td class="property-name">Vezeték nélküli</td>
          <td class="property-value"><div><span class="icon-ok" title="Igen"></span></div></td>
        </tr>
      </table>
    `;
    const $ = cheerio.load(html);
    const config = arukeresoConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.categorySlug).toBe('mice');
    // No meta[itemprop="description"] tag present in this fixture, so
    // appendSyntheticSpec correctly adds nothing (matches the original
    // extractCategory/extractDescription behavior of only pushing a
    // synthetic spec when a description value was actually found).
    expect(result.rawSpecs).toEqual([
      {
        sectionTitle: 'Alapadatok',
        name: 'Vezeték nélküli',
        description: undefined,
        values: ['Igen'],
      },
    ]);
  });
});
