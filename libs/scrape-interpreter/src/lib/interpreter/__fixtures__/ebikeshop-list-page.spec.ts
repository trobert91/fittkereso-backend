import * as cheerio from 'cheerio';
import { ScrapingSourceConfig, ProductImportTask } from '@fittkereso-backend/database';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
import ebikeshopConfig from './ebikeshop.config.json';
import {
  EbikeshopCapture,
  ebikeshopCards,
  ebikeshopPageHtml,
  loadEbikeshopCapture,
} from './ebikeshop/ebikeshop-captures';

// Real captures of ebikeshop.hu list pages (see ./ebikeshop/README.md). The
// whole page's state — cards, pagination, category title — is embedded as JSON
// in one `data-page` attribute rather than rendered as scrapeable HTML cards.
const config = ebikeshopConfig as unknown as ScrapingSourceConfig;

function makeTask(capture: EbikeshopCapture): ProductImportTask {
  return { id: 'task-1', url: capture.requestedUrl } as ProductImportTask;
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

  async function runListPage(capture: EbikeshopCapture) {
    const $ = cheerio.load(ebikeshopPageHtml(capture));
    return interpreter.runListPage(makeTask(capture), $, config);
  }

  it('extracts the category name and each card’s identity', async () => {
    const result = await runListPage(loadEbikeshopCapture('list-page-7'));

    expect(result.categoryName).toBe('Elektromos kerékpárok');

    // Prices have their own tests below.
    expect(
      result.products.map(({ url, externalId, name, currency }) => ({ url, externalId, name, currency })),
    ).toEqual([
      {
        url: 'https://ebikeshop.hu/termek/macina-style-820-d-46-white-black-red-1x11-shimano-cues',
        // Same field detailPage.offers reads for externalId, so a list refresh
        // updates the very offer a detail scrape created.
        externalId: '1250158236',
        name: 'KTM MACINA STYLE 820 TR46cm fehér elektromos kerékpár',
        currency: 'HUF',
      },
      {
        url: 'https://ebikeshop.hu/termek/macina-style-830-abs-diamond-blk-mt-grey-orange-1x10-shimano-deore-lg',
        externalId: '1250155116',
        name: 'KTM MACINA STYLE 830 ABS HE56cm fekete elektromos kerékpár',
        currency: 'HUF',
      },
      {
        url: 'https://ebikeshop.hu/termek/macina-gran-810-h-60-machine-grey-matt-silver-blk-1x11-shimano-cues',
        externalId: '1260131120',
        name: "KTM MACINA GRAN 810 HE60cm '26 szürke elektromos kerékpár",
        currency: 'HUF',
      },
      {
        url: 'https://ebikeshop.hu/termek/rm-tinker2-vario-cm-24-feher-elektromos-kerekpar-545wh-kiox-300-zar-taskaval',
        externalId: 'F01240_34010424060509',
        name: 'RM Tinker2 vario cm fehér elektromos kerékpár (545Wh, Kiox 300 , Zár táskával)',
        currency: 'HUF',
      },
      {
        url: 'https://ebikeshop.hu/termek/haibike-allmtn-cf-11-i750wh-47-cm-22-lila-elektromos-kerekpar-5695',
        externalId: '45161247',
        name: 'Haibike AllMtn CF 11 i750Wh 47 cm lila-kék elektromos kerékpár',
        currency: 'HUF',
      },
    ]);
  });

  // Each card's stock title. With a price and availability a known card is
  // refreshed in place, which is what spares it a paid detail fetch. The site's
  // own JSON-LD says PreOrder for manufacturer stock, as the mapping does.
  it('maps each stock title to availability', async () => {
    const page7 = await runListPage(loadEbikeshopCapture('list-page-7'));
    const page14 = await runListPage(loadEbikeshopCapture('list-page-14'));

    expect(
      [...page7.products, ...page14.products].map(({ externalId, availability }) => [externalId, availability]),
    ).toEqual([
      ['1250158236', 'preorder'], // Gyártói készlet
      ['1250155116', 'preorder'], // Gyártói készlet
      ['1260131120', 'preorder'], // Gyártói tervezet
      ['F01240_34010424060509', 'in_stock'], // Készleten
      ['45161247', 'in_stock'], // Készleten
      ['1260240117', 'in_stock'], // Készleten
      ['93AS1002', 'in_stock'], // Készleten
      ['MY26_114500-46E', 'preorder'], // Várható gyártás
    ]);
  });

  // Guessing would write a wrong stock state; without one the card is too thin
  // to refresh in place, and its detail page says what the stock is.
  it('maps a stock title it does not know to no availability', async () => {
    const capture = loadEbikeshopCapture('list-page-7');
    ebikeshopCards(capture)[0].preorderTypeTitle = 'Új készletállapot';

    const result = await runListPage(capture);

    expect(result.products[0].availability).toBeUndefined();
  });

  it('prices a card on sale at its sale price, with the regular price as the old one', async () => {
    const result = await runListPage(loadEbikeshopCapture('list-page-7'));
    const haibike = result.products.find((product) => product.externalId === '45161247');

    expect(haibike?.price).toBe(1799000);
    // The shop's regular price is 1999000.0025: float noise, rounded away.
    expect(haibike?.priceWithoutDiscount).toBe(1999000);
  });

  // ebikeshop sets `prices.priceSale` to 0 on every card that is not on sale,
  // so the card price must come from `prices.price` there. (It used to read
  // priceSale unconditionally, pricing those cards at 0.)
  it('prices a card that is not on sale at its regular price, with no old price', async () => {
    const capture = loadEbikeshopCapture('list-page-7');
    const result = await runListPage(capture);
    const cards = ebikeshopCards(capture);

    const notOnSale = cards.filter((card) => !card.prices.sale);
    expect(notOnSale.length).toBeGreaterThan(0);
    for (const card of notOnSale) {
      expect(card.prices.priceSale).toBe(0);
      const product = result.products.find((candidate) => candidate.externalId === card.productCode);
      expect(product?.price).toBe(Math.round(card.prices.price));
      expect(product?.priceWithoutDiscount).toBeUndefined();
    }
  });

  // The regular price carries float noise either side of the whole number;
  // the card shows the rounded one ("3 899 000 Ft" for 3898999.9998).
  it('rounds the regular price to the whole forint the shop displays', async () => {
    const capture = loadEbikeshopCapture('list-page-7');
    const card = ebikeshopCards(capture)[0];
    card.prices.price = 3898999.9998;

    const result = await runListPage(capture);

    expect(result.products[0].price).toBe(3899000);
  });

  it('filters out used bikes', async () => {
    const capture = loadEbikeshopCapture('list-page-7');
    const used = ebikeshopCards(capture)[1];
    used.isUsed = true;

    const result = await runListPage(capture);

    expect(result.products.map((product) => product.externalId)).not.toContain(used.productCode);
    expect(result.products).toHaveLength(4);
  });

  it('reads the page count from the listing', async () => {
    const capture = loadEbikeshopCapture('list-page-14');
    const pagination = config.listPage.pagination;
    if (!pagination) throw new Error('the ebikeshop config paginates');

    const pageCount = await interpreter.runPipeline(
      pagination.pageCount,
      makeTask(capture),
      cheerio.load(ebikeshopPageHtml(capture)),
      config,
    );

    expect(pageCount).toBe(19);
  });

  // Laravel sometimes serializes `props.products` as an object keyed by the
  // surviving indices ("0", "1", "2", "15"). parseJsonAttr reads it as an
  // array; before, `filterJsonArray` returned [] for it, and the whole page
  // silently yielded no cards.
  it('reads a page whose products are serialized as an object', async () => {
    const capture = loadEbikeshopCapture('list-all-page-30-object-shaped');

    const result = await runListPage(capture);

    expect(result.products.map((product) => product.externalId)).toEqual(
      ebikeshopCards(capture).map((card) => card.productCode),
    );
  });

  // Parsing a list page can no longer enqueue anything. Category expansion and
  // pagination are resolved once per run by ScrapingImportService, which is what
  // makes a self-paginating listing structurally unable to re-emit its own page
  // range — previously page 1 spawned 19 list tasks and each of those spawned 19
  // more, so both live configs had to leave categoryLinks empty as a workaround.
  it('returns only products — a list page cannot emit further list pages', async () => {
    const result = await runListPage(loadEbikeshopCapture('list-page-14'));

    expect(Object.keys(result).sort()).toEqual(['categoryName', 'products']);
  });
});
