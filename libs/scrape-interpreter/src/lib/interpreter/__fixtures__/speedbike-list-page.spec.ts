import * as cheerio from 'cheerio';
import { ProductSourceConfig, ScrapeTask } from '@fittkereso-backend/database';
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

function makeTask(): ScrapeTask {
  return {
    id: 'task-1',
    url: 'https://speedbike.hu/index.php?route=filter&filter=category|1087/manufacturer|268',
  } as ScrapeTask;
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

  it('extracts one product link per listing, titled from the anchor', async () => {
    const $ = cheerio.load(buildHtml());
    const config = speedbikeConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runListPage(makeTask(), $, config);

    expect(result.categoryName).toBe('Termékek szűrése');
    expect(result.productLinks).toEqual([
      {
        url: 'https://speedbike.hu/ktm-macina-chacana-591-flaming-black-greyorange-ferfi-elektromos-osszeteleszkopos-mtb-kerekpar-2022',
        title:
          'KTM MACINA CHACANA 591 FLAMING BLACK (GREY+ORANGE) FÉRFI ELEKTROMOS ÖSSZETELESZKÓPOS MTB KERÉKPÁR 2022',
      },
      {
        url: 'https://speedbike.hu/ktm-macina-lycan-772-glorious-night-red-rose-gold-noi-elektromos-osszleteszkopos-mtb-karekpar-2022',
        title:
          'KTM MACINA LYCAN 772 GLORIOUS NIGHT (RED+ROSE GOLD) NŐI ELEKTROMOS ÖSSZTELESZKÓPOS MTB KERÉKPÁR 2022',
      },
    ]);
  });

  it('emits no pagination links even though the page has them', async () => {
    const $ = cheerio.load(buildHtml());
    const config = speedbikeConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runListPage(makeTask(), $, config);

    // Self-pagination would re-emit the whole page range from every page it
    // landed on (generatePaginationLinks has no "only on page 1" guard, and
    // createCategoryTasks doesn't dedupe), so page ranges are enumerated by
    // apps/product-collector/scripts/enqueue-ktm-catalog.ts instead.
    expect(result.categoryLinks).toEqual([]);
  });
});
