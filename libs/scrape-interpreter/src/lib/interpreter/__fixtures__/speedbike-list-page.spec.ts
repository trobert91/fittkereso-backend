import * as cheerio from 'cheerio';
import { ScrapingSourceConfig, ProductImportTask } from '@fittkereso-backend/database';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
import speedbikeConfig from './speedbike.config.json';

// Trimmed capture of speedbike.hu's KTM e-bike filter listing
// (index.php?route=filter&filter=category|1087/manufacturer|268), which is
// how a brand-scoped catalog run enters the site. Each product is a group of
// `.snapshot-list-item` divs — the thumbnail anchor and the name anchor both
// point at the same detail page, so the config selects the name box only and
// the thumbnail must not yield a second, duplicate link.
//
// `list_prouctname` is misspelled in the site's own markup; the selector has
// to match it verbatim.
function buildHtml(): string {
  const product = (slug: string, name: string) => `
    <div class="product-snapshot">
      <div class="snapshot-list-item list_prouctimage">
        <a class="img-thumbnail-link" href="https://speedbike.hu/${slug}" title="${name}">
          <img class="img-thumbnail" alt="${name}" />
        </a>
      </div>
      <div class="snapshot-list-item list_prouctname">
        <a class="list-productname-link" href="https://speedbike.hu/${slug}" title="${name}">${name}</a>
      </div>
      <div class="snapshot-list-item list_prouctprice">
        <span class="price">1.339.990 Ft</span>
      </div>
    </div>`;

  return `
    <html>
      <body>
        <h1 class="page-head-center-title">Termékek szűrése</h1>
        ${product(
          'ktm-macina-chacana-591-flaming-black-greyorange-ferfi-elektromos-osszeteleszkopos-mtb-kerekpar-2022',
          'KTM MACINA CHACANA 591 FLAMING BLACK (GREY+ORANGE) FÉRFI ELEKTROMOS ÖSSZETELESZKÓPOS MTB KERÉKPÁR 2022',
        )}
        ${product(
          'ktm-macina-lycan-772-glorious-night-red-rose-gold-noi-elektromos-osszleteszkopos-mtb-karekpar-2022',
          'KTM MACINA LYCAN 772 GLORIOUS NIGHT (RED+ROSE GOLD) NŐI ELEKTROMOS ÖSSZTELESZKÓPOS MTB KERÉKPÁR 2022',
        )}
        <div class="pagination-wrapper">
          <a class="pagination-link" href="https://speedbike.hu/index.php?route=filter&amp;filter=category|1087/manufacturer|268&amp;page=2#content">2</a>
          <a class="pagination-link pagination_navi pagination_last" href="https://speedbike.hu/index.php?route=filter&amp;filter=category|1087/manufacturer|268&amp;page=6#content">6</a>
        </div>
      </body>
    </html>`;
}

function makeTask(): ProductImportTask {
  return {
    id: 'task-1',
    url: 'https://speedbike.hu/index.php?route=filter&filter=category|1087/manufacturer|268',
  } as ProductImportTask;
}

describe('speedbike.hu list page — declarative config golden fixture', () => {
  let interpreter: ScrapeInterpreterService;

  beforeEach(() => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());

    const runtime: RuntimeDataProvider = {
      getBrandNames: jest.fn().mockResolvedValue(['KTM']),
      getCategoryBySlug: jest.fn(),
    };

    interpreter = new ScrapeInterpreterService(runner, runtime as never);
  });

  it('extracts one card per listing, with the price read off the card', async () => {
    const $ = cheerio.load(buildHtml());
    const config = speedbikeConfig as unknown as ScrapingSourceConfig;

    const result = await interpreter.runListPage(makeTask(), $, config);

    expect(result.categoryName).toBe('Termékek szűrése');
    expect(result.products).toEqual([
      {
        url: 'https://speedbike.hu/ktm-macina-chacana-591-flaming-black-greyorange-ferfi-elektromos-osszeteleszkopos-mtb-kerekpar-2022',
        name: 'KTM MACINA CHACANA 591 FLAMING BLACK (GREY+ORANGE) FÉRFI ELEKTROMOS ÖSSZETELESZKÓPOS MTB KERÉKPÁR 2022',
        // "1.339.990 Ft" — the thousands separators are dots, so the price
        // pipeline strips every non-digit rather than parsing as a decimal.
        price: 1339990,
        currency: 'HUF',
        externalId: undefined,
        priceWithoutDiscount: undefined,
        // The listing card shows a price but no stock, so under the default
        // minimum set these items still fall through to a detail scrape.
        availability: undefined,
      },
      {
        url: 'https://speedbike.hu/ktm-macina-lycan-772-glorious-night-red-rose-gold-noi-elektromos-osszleteszkopos-mtb-karekpar-2022',
        name: 'KTM MACINA LYCAN 772 GLORIOUS NIGHT (RED+ROSE GOLD) NŐI ELEKTROMOS ÖSSZTELESZKÓPOS MTB KERÉKPÁR 2022',
        price: 1339990,
        currency: 'HUF',
        externalId: undefined,
        priceWithoutDiscount: undefined,
        availability: undefined,
      },
    ]);
  });

  // Each product is a group of sibling `.snapshot-list-item` divs — the
  // thumbnail anchor and the name anchor point at the same detail page — so
  // scoping every sub-pipeline to the card is what stops one listing yielding
  // two cards, or one card borrowing another's price.
  it('reads each card independently rather than the whole page', async () => {
    const $ = cheerio.load(buildHtml());
    const config = speedbikeConfig as unknown as ScrapingSourceConfig;

    const result = await interpreter.runListPage(makeTask(), $, config);

    expect(result.products).toHaveLength(2);
    expect(new Set(result.products.map((p) => p.url)).size).toBe(2);
  });

  it('emits no further list pages even though the page shows pagination', async () => {
    const $ = cheerio.load(buildHtml());
    const config = speedbikeConfig as unknown as ScrapingSourceConfig;

    const result = await interpreter.runListPage(makeTask(), $, config);

    // Pagination is resolved once per run by ScrapingImportService, so a list
    // page has no way to enqueue more list pages — which is what makes the old
    // re-emission bug (every page re-emitting the whole range) impossible
    // rather than merely worked around by leaving categoryLinks empty.
    expect(Object.keys(result).sort()).toEqual(['categoryName', 'products']);
  });
});
