import * as cheerio from 'cheerio';
import { ScrapingSourceConfig, ProductImportTask } from '@fittkereso-backend/database';
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
      // Not discounted: sale=false, so priceSale equals price and there is no
      // pre-discount value to carry.
      {
        showPageUrl:
          'https://ebikeshop.hu/termek/macina-scarp-sx-exonic-fresh-orange-dark-chrome-1x12a-srama-xxa-transmission',
        productName:
          "KTM MACINA SCARP SX EXONICX T-TYPE 48cm &#39;26 narancs elektromos kerékpár",
        productCode: 'KTM-EXONIC-48',
        prices: { price: 2465991, priceSale: 2465991, sale: false, vat: 27 },
        isUsed: false,
        manufacturer: { title: 'KTM', slug: 'ktm' },
      },
      // Discounted: sale=true, so the original price becomes
      // priceWithoutDiscount and priceSale becomes the current price.
      {
        showPageUrl:
          'https://ebikeshop.hu/termek/rm-nevo5-gt-vario-hs-us50-cm-26-kek-elektromos-kerekpar-800wh-kiox500-zar-taskaval',
        productName:
          "RM Nevo5 GT vario HS US50 cm &#39;26 kék elektromos kerékpár (800Wh, Kiox500, Zár táskával)",
        productCode: 'RM-NEVO5-US50',
        prices: { price: 1899000, priceSale: 1699000, sale: true, vat: 27 },
        isUsed: false,
        manufacturer: null,
      },
      {
        showPageUrl: 'https://ebikeshop.hu/termek/used-bike-example',
        productName: 'Used Test Bike elektromos kerékpár',
        productCode: 'USED-1',
        prices: { price: 500000, priceSale: 500000, sale: false, vat: 27 },
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

function makeTask(): ProductImportTask {
  return {
    id: 'task-1',
    url: 'https://ebikeshop.hu/termekek/elektromos-kerekparok',
  } as ProductImportTask;
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

  it('extracts category name and product cards with used bikes filtered out', async () => {
    const $ = cheerio.load(buildHtml());
    const config = ebikeshopConfig as unknown as ScrapingSourceConfig;

    const result = await interpreter.runListPage(makeTask(), $, config);

    expect(result.categoryName).toBe('Elektromos kerékpárok');

    // Cards now carry price and identity, not just a link — which is what lets
    // an already-known listing be refreshed without opening its detail page.
    expect(result.products).toEqual([
      {
        url: 'https://ebikeshop.hu/termek/macina-scarp-sx-exonic-fresh-orange-dark-chrome-1x12a-srama-xxa-transmission',
        name: "KTM MACINA SCARP SX EXONICX T-TYPE 48cm '26 narancs elektromos kerékpár",
        // Same field detailPage.offers reads for externalId, so a list refresh
        // updates the very offer a detail scrape created.
        externalId: 'KTM-EXONIC-48',
        price: 2465991,
        // Not on sale, so no pre-discount price.
        priceWithoutDiscount: undefined,
        currency: 'HUF',
        // props.products carries no stock at all — the detail page derives
        // availability from an "Üzletek" store list that only exists there.
        // Absent rather than `unknown`, so a refresh cannot degrade it.
        availability: undefined,
      },
      {
        url: 'https://ebikeshop.hu/termek/rm-nevo5-gt-vario-hs-us50-cm-26-kek-elektromos-kerekpar-800wh-kiox500-zar-taskaval',
        name: "RM Nevo5 GT vario HS US50 cm '26 kék elektromos kerékpár (800Wh, Kiox500, Zár táskával)",
        externalId: 'RM-NEVO5-US50',
        price: 1699000,
        priceWithoutDiscount: 1899000,
        currency: 'HUF',
        availability: undefined,
      },
    ]);
  });

  // Parsing a list page can no longer enqueue anything. Category expansion and
  // pagination are resolved once per run by ScrapingImportService, which is what
  // makes a self-paginating listing structurally unable to re-emit its own page
  // range — previously page 1 spawned 19 list tasks and each of those spawned 19
  // more, so both live configs had to leave categoryLinks empty as a workaround.
  it('returns only products — a list page cannot emit further list pages', async () => {
    const $ = cheerio.load(buildHtml());
    const config = ebikeshopConfig as unknown as ScrapingSourceConfig;

    const result = await interpreter.runListPage(makeTask(), $, config);

    expect(Object.keys(result).sort()).toEqual(['categoryName', 'products']);
  });
});
