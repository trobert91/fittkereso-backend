import * as cheerio from 'cheerio';
import { ProductSourceConfig, ScrapeTask } from '@fittkereso-backend/database';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
import ebikeshopConfig from './ebikeshop.config.json';

// Trimmed, real capture of ebikeshop.hu's Inertia `data-page` payload for a
// product detail page (KTM Macina Scarp SX, manufacturer_planning stock —
// exercises the "Gyártói készlet" -> preorder availability branch and the
// non-sale price branch).
const EBIKESHOP_DETAIL_PAGE_DATA = {
  props: {
    product: {
      name: "KTM MACINA SCARP SX EXONICX T-TYPE 48cm &#39;26 narancs elektromos kerékpár",
      manufacturer: {
        id: 218,
        title: 'KTM',
        url: 'https://ebikeshop.hu/ktm',
        slug: 'ktm',
      },
      legalManufacturerName: 'KTM Fahrrad GmbH',
      productCode: '1260040108',
      prices: {
        price: 3879000.0017,
        priceSale: 0,
        sale: false,
      },
      images: [
        {
          type: 'gallery',
          images: [
            { code: 'thumb_640', url: 'https://ebikeshop.hu/img/a-thumb.webp' },
            { code: 'thumb_1280', url: 'https://ebikeshop.hu/img/a-mid.webp' },
            { code: 'original', url: 'https://ebikeshop.hu/img/a.webp' },
          ],
        },
      ],
      stocks: [
        {
          stockType: 'manufacturer_planning',
          title: 'Gyártói készlet',
          preorder: 2,
          qty: 21,
          preorderTypeTitle: 'Gyártói készlet',
          expired: false,
        },
      ],
      properties: [
        {
          value: 'Új',
          categoryTitle: 'Állapot',
          quantityUnit: '',
        },
        {
          value: '60',
          categoryTitle: 'Nyomaték',
          quantityUnit: 'Nm',
        },
        {
          value: '48',
          categoryTitle: 'Vázméret',
          quantityUnit: 'cm',
        },
        {
          value: '26',
          categoryTitle: 'Modellév',
          quantityUnit: '',
        },
        {
          value: '11',
          categoryTitle: 'Váltó sebességfokozatainak száma',
          quantityUnit: '',
        },
      ],
    },
  },
};

function buildHtml(): string {
  const json = JSON.stringify(EBIKESHOP_DETAIL_PAGE_DATA)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  return `<div id="app" data-page="${json}"></div>`;
}

function makeTask(): ScrapeTask {
  return {
    id: 'task-1',
    url: 'https://ebikeshop.hu/termek/macina-scarp-sx-exonic-fresh-orange-dark-chrome-1x12a-srama-xxa-transmission',
  } as ScrapeTask;
}

describe('ebikeshop detail page — declarative config golden fixture', () => {
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

  it('extracts brand/model/category/rawSpecs/images/offers from the JSON hydration payload', async () => {
    const $ = cheerio.load(buildHtml());
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.brand).toBe('KTM');
    expect(result.model).toBe("MACINA SCARP SX EXONICX T-TYPE 48cm '26 narancs");
    expect(result.categorySlug).toBe('ebikes');

    expect(result.rawSpecs).toEqual([
      { name: 'Állapot', values: ['Új'] },
      { name: 'Nyomaték', values: ['60 Nm'] },
      { name: 'Vázméret', values: ['48 cm'] },
      { name: 'Modellév', values: ['26'] },
      { name: 'Váltó sebességfokozatainak száma', values: ['11'] },
    ]);

    expect(result.releaseYear).toBe(2026);

    expect(result.imageUrls).toEqual(['https://ebikeshop.hu/img/a.webp']);

    expect(result.rawOffers).toEqual([
      {
        sellerName: 'ebikeshop.hu',
        price: 3879000.0017,
        currency: 'HUF',
        availability: 'preorder',
        url: 'https://ebikeshop.hu/termek/macina-scarp-sx-exonic-fresh-orange-dark-chrome-1x12a-srama-xxa-transmission',
        sourceListingId: '1260040108',
      },
    ]);
  });

  it('falls back to a cleaned legalManufacturerName when manufacturer is null', async () => {
    const data = JSON.parse(JSON.stringify(EBIKESHOP_DETAIL_PAGE_DATA));
    data.props.product.manufacturer = null;
    data.props.product.legalManufacturerName = 'Riese & Müller GmbH';
    const json = JSON.stringify(data).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const $ = cheerio.load(`<div id="app" data-page="${json}"></div>`);
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.brand).toBe('Riese & Müller');
  });

  it('prefers the sale price when prices.sale is true', async () => {
    const data = JSON.parse(JSON.stringify(EBIKESHOP_DETAIL_PAGE_DATA));
    data.props.product.prices = { price: 4099000, priceSale: 3699000, sale: true };
    const json = JSON.stringify(data).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const $ = cheerio.load(`<div id="app" data-page="${json}"></div>`);
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.rawOffers[0].price).toBe(3699000);
  });

  it('maps "Készleten" stock status to in_stock availability', async () => {
    const data = JSON.parse(JSON.stringify(EBIKESHOP_DETAIL_PAGE_DATA));
    data.props.product.stocks = [
      { stockType: 'stock', title: 'Törökbálint', qty: 1, preorderTypeTitle: 'Készleten' },
    ];
    const json = JSON.stringify(data).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const $ = cheerio.load(`<div id="app" data-page="${json}"></div>`);
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.rawOffers[0].availability).toBe('in_stock');
  });
});
