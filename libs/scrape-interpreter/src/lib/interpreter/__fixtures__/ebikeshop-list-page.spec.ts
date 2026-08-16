import * as cheerio from 'cheerio';
import { ProductSourceConfig, ScrapeTask } from '@fittkereso-backend/database';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
import ebikeshopConfig from './ebikeshop.config.json';

// This is a trimmed, real capture of ebikeshop.hu's Inertia `data-page`
// payload for /termekek/elektromos-kerekparok — the whole page's state
// (list, pagination, category title) is embedded as JSON in that one
// attribute rather than rendered as scrapeable HTML cards. Includes one
// isUsed:true entry to exercise the used-bike filter.
const EBIKESHOP_LIST_PAGE_DATA = {
  props: {
    meta: { h1Title: 'Elektromos kerékpárok' },
    lastPage: 20,
    currentPage: 1,
    products: [
      {
        showPageUrl:
          'https://ebikeshop.hu/termek/macina-scarp-sx-exonic-fresh-orange-dark-chrome-1x12a-srama-xxa-transmission',
        productName:
          "KTM MACINA SCARP SX EXONICX T-TYPE 48cm &#39;26 narancs elektromos kerékpár",
        isUsed: false,
        manufacturer: { title: 'KTM', slug: 'ktm' },
      },
      {
        showPageUrl:
          'https://ebikeshop.hu/termek/rm-nevo5-gt-vario-hs-us50-cm-26-kek-elektromos-kerekpar-800wh-kiox500-zar-taskaval',
        productName:
          "RM Nevo5 GT vario HS US50 cm &#39;26 kék elektromos kerékpár (800Wh, Kiox500, Zár táskával)",
        isUsed: false,
        manufacturer: null,
      },
      {
        showPageUrl: 'https://ebikeshop.hu/termek/used-bike-example',
        productName: 'Used Test Bike elektromos kerékpár',
        isUsed: true,
        manufacturer: { title: 'TestBrand', slug: 'testbrand' },
      },
    ],
  },
};

function buildHtml(): string {
  const json = JSON.stringify(EBIKESHOP_LIST_PAGE_DATA)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  return `<div id="app" data-page="${json}"></div>`;
}

function makeTask(): ScrapeTask {
  return {
    id: 'task-1',
    url: 'https://ebikeshop.hu/termekek/elektromos-kerekparok',
  } as ScrapeTask;
}

describe('ebikeshop list page — declarative config golden fixture', () => {
  let interpreter: ScrapeInterpreterService;

  beforeEach(() => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registerOps(registry, runner, new ProductValueMapperService());

    const runtime: RuntimeDataProvider = {
      getBrandNames: jest.fn().mockResolvedValue([]),
      getCategoryBySlug: jest.fn(),
    };

    interpreter = new ScrapeInterpreterService(runner, runtime as never);
  });

  it('extracts category name, pagination links, and product links with used bikes filtered out', async () => {
    const $ = cheerio.load(buildHtml());
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runListPage(makeTask(), $, config);

    expect(result.categoryName).toBe('Elektromos kerékpárok');

    expect(result.productLinks).toEqual([
      {
        url: 'https://ebikeshop.hu/termek/macina-scarp-sx-exonic-fresh-orange-dark-chrome-1x12a-srama-xxa-transmission',
        title: "KTM MACINA SCARP SX EXONICX T-TYPE 48cm '26 narancs elektromos kerékpár",
      },
      {
        url: 'https://ebikeshop.hu/termek/rm-nevo5-gt-vario-hs-us50-cm-26-kek-elektromos-kerekpar-800wh-kiox500-zar-taskaval',
        title: "RM Nevo5 GT vario HS US50 cm '26 kék elektromos kerékpár (800Wh, Kiox500, Zár táskával)",
      },
    ]);

    // Page 1 of 20, pagination generated for pages 2..20.
    expect(result.categoryLinks).toHaveLength(19);
    expect(result.categoryLinks[0]).toEqual({
      url: 'https://ebikeshop.hu/termekek/elektromos-kerekparok?oldal=2',
      title: 'Page 2',
    });
    expect(result.categoryLinks[18]).toEqual({
      url: 'https://ebikeshop.hu/termekek/elektromos-kerekparok?oldal=20',
      title: 'Page 20',
    });
  });
});
