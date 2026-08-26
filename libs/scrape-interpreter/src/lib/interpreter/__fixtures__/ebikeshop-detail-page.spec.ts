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
// product detail page (KTM Macina Scarp SX). `stocks` is kept for the raw
// spec/brand/model extraction it's unrelated to — offers themselves are now
// built from the JSON-LD `Offer` script block and the "Üzletek" stores DOM
// section (see buildHtml), confirmed live against real ebikeshop.hu pages.
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
        {
          value: 'Bosch',
          categoryTitle: 'Motor gyártója',
          quantityUnit: '',
        },
        {
          value: 'Bosch Performance Line CX',
          categoryTitle: 'Motor típusa',
          quantityUnit: '',
        },
        {
          value: 'Shimano XT',
          categoryTitle: 'Váltó',
          quantityUnit: '',
        },
        {
          value: 'Elektromos',
          categoryTitle: 'Váltó működése',
          quantityUnit: '',
        },
      ],
    },
  },
};

// Mirrors the real <script type="application/ld+json"> schema.org Offer
// block ebikeshop.hu embeds on every product page — confirmed live to carry
// a reliable three-state availability (InStock/PreOrder/OutOfStock)
// independent of props.product.stocks, which is empty whenever a variant is
// out of stock.
function buildJsonLdScript(price: number, availability: string): string {
  const offer = {
    '@type': 'Offer',
    url: 'https://ebikeshop.hu/termek/macina-scarp-sx-exonic-fresh-orange-dark-chrome-1x12a-srama-xxa-transmission',
    priceCurrency: 'HUF',
    price,
    itemCondition: 'https://schema.org/NewCondition',
    availability: `https://schema.org/${availability}`,
    seller: 'https://ebikeshop.hu',
  };
  return `<script type="application/ld+json">[{"@context":"https://schema.org","@type":"Product","offers":${JSON.stringify(offer)}}]</script>`;
}

// Mirrors the real "Üzletek" (Stores) DOM section — confirmed live in three
// shapes: no <li> at all when out of stock, one <li> for "Gyártói készlet"
// (manufacturer/supplier stock, not a real store), or one <li> per physical
// store when in stock at one or more locations.
function buildStoresSection(storeNames: string[]): string {
  const items = storeNames
    .map(
      (name) =>
        `<li><div class="flex flex-wrap items-center gap-4"><span>${name}</span><div class="flex items-center gap-2"><span class="text-success">Elérhető</span></div></div></li>`,
    )
    .join('');
  const body =
    storeNames.length > 0
      ? `<ul class="space-y-2">${items}</ul>`
      : `<div class="flex flex-wrap items-center gap-4"><div class="flex items-center gap-2"><span class="text-error">Jelenleg nincs készleten</span></div></div>`;
  return `<h3>Üzletek</h3>${body}<div data-slot="separator-root"></div>`;
}

function buildHtml(options?: {
  data?: unknown;
  jsonLdPrice?: number;
  jsonLdAvailability?: string;
  storeNames?: string[];
}): string {
  const data = options?.data ?? EBIKESHOP_DETAIL_PAGE_DATA;
  const json = JSON.stringify(data).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const jsonLd = buildJsonLdScript(
    options?.jsonLdPrice ?? 3879000.0017,
    options?.jsonLdAvailability ?? 'PreOrder',
  );
  const stores = buildStoresSection(options?.storeNames ?? ['Gyártói készlet']);
  return `<div id="app" data-page="${json}"></div>${jsonLd}${stores}`;
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
      { name: 'Motor gyártója', values: ['Bosch'] },
      { name: 'Motor típusa', values: ['Bosch Performance Line CX'] },
      { name: 'Váltó', values: ['Shimano XT'] },
      { name: 'Váltó működése', values: ['Elektromos'] },
    ]);

    expect(result.releaseYear).toBe(2026);

    expect(result.externalId).toBe('1260040108');

    expect(result.imageUrls).toEqual(['https://ebikeshop.hu/img/a.webp']);

    expect(result.rawOffers).toEqual([
      {
        price: 3879000.0017,
        priceWithoutDiscount: undefined,
        currency: 'HUF',
        availability: 'preorder',
        url: 'https://ebikeshop.hu/termek/macina-scarp-sx-exonic-fresh-orange-dark-chrome-1x12a-srama-xxa-transmission',
        externalId: '1260040108',
        locations: undefined,
        specs: undefined,
      },
    ]);
  });

  it('falls back to a cleaned legalManufacturerName when manufacturer is null', async () => {
    const data = JSON.parse(JSON.stringify(EBIKESHOP_DETAIL_PAGE_DATA));
    data.props.product.manufacturer = null;
    data.props.product.legalManufacturerName = 'Riese & Müller GmbH';
    const $ = cheerio.load(buildHtml({ data }));
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.brand).toBe('Riese & Müller');
  });

  it('prefers the sale price when prices.sale is true, and reports priceWithoutDiscount', async () => {
    const data = JSON.parse(JSON.stringify(EBIKESHOP_DETAIL_PAGE_DATA));
    data.props.product.prices = { price: 4099000, priceSale: 3699000, sale: true };
    const $ = cheerio.load(buildHtml({ data, jsonLdPrice: 3699000 }));
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.rawOffers[0].price).toBe(3699000);
    expect(result.rawOffers[0].priceWithoutDiscount).toBe(4099000);
  });

  it('omits priceWithoutDiscount when prices.sale is false', async () => {
    const $ = cheerio.load(buildHtml());
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.rawOffers[0].price).toBe(3879000.0017);
    expect(result.rawOffers[0].priceWithoutDiscount).toBeUndefined();
  });

  it('maps JSON-LD InStock availability to in_stock, with real store names as locations', async () => {
    const $ = cheerio.load(
      buildHtml({
        jsonLdAvailability: 'InStock',
        storeNames: ['Törökbálinti raktár', 'Törökbálint'],
      }),
    );
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.rawOffers).toHaveLength(1);
    expect(result.rawOffers[0].availability).toBe('in_stock');
    expect(result.rawOffers[0].locations).toEqual(['Törökbálinti raktár', 'Törökbálint']);
  });

  // Confirmed live: an out-of-stock variant's props.product.stocks is an
  // empty array (no per-store rows at all), so availability can only be
  // recovered from the JSON-LD Offer block, and there is no "Üzletek" <li>
  // list on the page at all (just a "Jelenleg nincs készleten" badge).
  it('maps JSON-LD OutOfStock availability to out_of_stock, with no locations', async () => {
    const $ = cheerio.load(
      buildHtml({ jsonLdAvailability: 'OutOfStock', storeNames: [] }),
    );
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.rawOffers).toHaveLength(1);
    expect(result.rawOffers[0].availability).toBe('out_of_stock');
    expect(result.rawOffers[0].locations).toBeUndefined();
  });

  // Confirmed live: a preorder-only listing's sole "Üzletek" row is literally
  // "Gyártói készlet" (manufacturer/supplier stock) — not a real physical
  // store, so it must be filtered out of locations rather than reported as one.
  it('filters "Gyártói készlet" out of locations, leaving it undefined', async () => {
    const $ = cheerio.load(
      buildHtml({ jsonLdAvailability: 'PreOrder', storeNames: ['Gyártói készlet'] }),
    );
    const config = ebikeshopConfig as unknown as ProductSourceConfig;

    const result = await interpreter.runDetailPage(makeTask(), $, config);

    expect(result.rawOffers).toHaveLength(1);
    expect(result.rawOffers[0].availability).toBe('preorder');
    expect(result.rawOffers[0].locations).toBeUndefined();
  });
});
