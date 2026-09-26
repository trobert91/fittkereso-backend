import * as cheerio from 'cheerio';
import {
  ScrapingSourceConfig,
  ProductImportTask,
  ScrapedProductSpec,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import {
  ProductSpecNormalizationService,
  SpecExtractionService,
} from '@fittkereso-backend/product';
import { ScrapeInterpreterService } from '../scrape-interpreter.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { RuntimeDataProvider } from '../interfaces/runtime-data-provider.interface';
import { registerOps } from '../ops/register-ops';
import ebikeshopConfig from './ebikeshop.config.json';
import {
  EbikeshopCapture,
  EbikeshopProductJson,
  ebikeshopPageHtml,
  loadEbikeshopCapture,
} from './ebikeshop/ebikeshop-captures';
// The spec mapping is checked against the category's real, current schema, as
// speedbike-detail-page.spec.ts does, for the same reason.
// eslint-disable-next-line @nx/enforce-module-boundaries
import ebikesJsonSchema from '../../../../../config/src/lib/categories/ebikes/jsonSchema.json';

// Real captures of ebikeshop.hu product pages (see ./ebikeshop/README.md).
// Everything comes from the Inertia `data-page` JSON except the offer's
// availability, which the JSON-LD `Offer` script states.
const config = ebikeshopConfig as unknown as ScrapingSourceConfig;

/** What the deterministic spec mapping makes of a page's rows, before any LLM. */
function mappedSpecs(rawSpecs: ScrapedProductSpec[]) {
  const ebikes = config.detailPage.specMapping['ebikes'];
  return new SpecExtractionService(new ProductSpecNormalizationService()).extractSpecs({
    scrapedSpecs: rawSpecs,
    schema: ebikesJsonSchema as unknown as SpecDefinitionJsonSchema,
    sourceConfig: ebikes,
  });
}

function makeTask(capture: EbikeshopCapture): ProductImportTask {
  return { id: 'task-1', url: capture.requestedUrl } as ProductImportTask;
}

function productOf(capture: EbikeshopCapture): EbikeshopProductJson {
  const product = capture.dataPage.props.product;
  if (!product) throw new Error(`${capture.requestedUrl} has no product`);
  return product;
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

  async function runDetailPage(capture: EbikeshopCapture) {
    const $ = cheerio.load(ebikeshopPageHtml(capture));
    return interpreter.runDetailPage(makeTask(capture), $, config);
  }

  it('extracts brand/model/category/rawSpecs/images/offers from a real product page', async () => {
    const capture = loadEbikeshopCapture('detail-ktm-exonicx-48');

    const result = await runDetailPage(capture);

    expect(result.brand).toBe('KTM');
    expect(result.model).toBe("MACINA SCARP SX EXONICX T-TYPE 48cm '26 narancs");
    expect(result.categorySlug).toBe('ebikes');

    // All 23 rows ebikeshop publishes for an e-bike, value and unit joined.
    expect(result.rawSpecs).toEqual([
      { name: 'Állapot', values: ['Új'] },
      { name: 'Nyomaték', values: ['60 Nm'] },
      { name: 'Gyártó', values: ['KTM'] },
      { name: 'Modellév', values: ['26'] },
      { name: 'Vázméret', values: ['48 cm'] },
      { name: 'Váztípus', values: ['Összteleszkópos'] },
      { name: 'Felhasználás módja', values: ['MTB'] },
      { name: 'Maximális rásegítés', values: ['25 km/h'] },
      { name: 'Kijelző típus', values: ['Bosch Mini Remote'] },
      { name: 'Akku elhelyezkedése', values: ['Vázba integrált'] },
      { name: 'Kerékméret', values: ['29 "'] },
      { name: 'Erőátvitel', values: ['Lánc'] },
      { name: 'Rugózás', values: ['Első teleszkóp, hátsó rugóstag'] },
      { name: 'Féktípus', values: ['Shimano XTR'] },
      { name: 'Fékfajta', values: ['Tárcsa'] },
      { name: 'Váltó sebességfokozatainak száma', values: ['12'] },
      { name: 'Váltó', values: ['Sram XX Eagle'] },
      { name: 'Váltó típusa', values: ['Láncváltó'] },
      { name: 'Váltó működése', values: ['Elektromos'] },
      { name: 'Motor gyártója', values: ['Bosch'] },
      { name: 'Motor típusa', values: ['Bosch Performance SX (Smart System)'] },
      { name: 'Akku kapacitás', values: ['400 Wh'] },
      { name: 'Emelt teherbírás', values: ['Nem'] },
    ]);

    expect(result.releaseYear).toBe(2026);

    expect(result.externalId).toBe('1260040108');
    // The shop's own size grouping: every frame size of this bike, this page
    // included. Only this size carries a barcode, as live.
    expect(result.siblingIds).toEqual(['1260040103', '1260040108', '1260040113']);

    expect(result.imageUrls).toEqual([
      'https://ebikeshop.hu/storage/documents/file/2026-ktm-macina-scarp-sx-exonicx-t-type-48cm-26-narancs-elektromos-kerekpar-pe9b59e7-18790.webp',
    ]);

    expect(result.rawOffers).toEqual([
      {
        // prices.price is 3879000.0017; the shop shows "3 879 000 Ft".
        price: 3879000,
        priceWithoutDiscount: null,
        currency: 'HUF',
        // Manufacturer stock: JSON-LD PreOrder.
        availability: 'preorder',
        url: capture.requestedUrl,
        externalId: '1260040108',
        gtin: '9008594503199',
        mpn: '1260040108',
        // In no store: the page's only "Üzletek" row is "Gyártói készlet".
        locations: null,
        specs: undefined,
      },
    ]);
  });

  // The page's own category, so a redirect to another kind of product is not
  // filed as an e-bike.
  it('files a bike under ebikes by the category the page states', async () => {
    const capture = loadEbikeshopCapture('detail-ktm-exonicx-48');
    expect(productOf(capture).category).toMatchObject({ slug: 'elektromos-kerekparok' });

    const result = await runDetailPage(capture);

    expect(result.categorySlug).toBe('ebikes');
  });

  it('reads the model year from four digits as from two', async () => {
    const capture = loadEbikeshopCapture('detail-ktm-exonicx-48');
    const year = productOf(capture).properties.find((row) => row.categoryTitle === 'Modellév');
    if (!year) throw new Error('the capture states a model year');
    year.value = '2026';

    const result = await runDetailPage(capture);

    expect(result.releaseYear).toBe(2026);
  });

  describe('description', () => {
    // What is left is about this bike: its use, motor and display.
    it("drops the shop's brand blurb and its closing general block", async () => {
      const result = await runDetailPage(loadEbikeshopCapture('detail-ktm-exonicx-48'));

      expect(result.description).toMatch(
        /^<h3 class="product-desc-block-title">A kerékpár felhasználási módja:<\/h3>/,
      );
      expect(result.description).not.toContain('A gyártóról');
      // "Általános": the same user-manual and range-calculator links on every bike.
      expect(result.description).not.toContain('Általános');
      expect(result.description).toMatch(/Performance Line SX motorral[\s\S]*<\/p>$/);
    });

    // Its whole longDesc is KTM's blurb, in a <p> of its own.
    it('gives none for a bike whose text is only the brand blurb', async () => {
      const result = await runDetailPage(loadEbikeshopCapture('detail-ktm-chacana-791'));

      expect(result.description).toBeUndefined();
    });

    it('gives none for a bike whose text is only the general block', async () => {
      const capture = loadEbikeshopCapture('detail-rm-delite4-speed');
      expect(productOf(capture).longDesc).toMatch(/^<h3[^>]*>Általános<\/h3>/);

      const result = await runDetailPage(capture);

      expect(result.description).toBeUndefined();
    });
  });

  describe('spec mapping', () => {
    it('maps every row the ebikes schema has a key for', async () => {
      const result = await runDetailPage(loadEbikeshopCapture('detail-ktm-exonicx-48'));

      // Váztípus "Összteleszkópos" is neither a frame type nor a gender, and
      // is dropped; the LLM sees the row. Gyártó is the brand, Modellév the
      // release year, Emelt teherbírás a yes/no no key fits.
      expect(mappedSpecs(result.rawSpecs)).toEqual({
        frameSize: 48,
        usageType: 'MTB',
        condition: 'Új',
        batteryPosition: 'Vázba integrált',
        wheelSize: 29,
        drivetrain: 'Lánc',
        suspension: 'Első teleszkóp, hátsó rugóstag',
        brakeType: 'Tárcsa',
        brakeModel: 'Shimano XTR',
        gearType: 'Láncváltó',
        gearCount: 12,
        shiftingActuation: 'Elektromos',
        rearDerailleur: 'Sram XX Eagle',
        batteryCapacity: 400,
        torque: 60,
        motorBrand: 'Bosch',
        motorModel: 'Bosch Performance SX (Smart System)',
        topSpeed: 25,
        pedelecClass: 'Pedelec',
        displayModel: 'Bosch Mini Remote',
      });
    });

    // A 45 km/h S-Pedelec on 27,5" wheels, with a stepless Enviolo hub.
    it('reads a decimal comma, the S-Pedelec class, and no gear count for a stepless hub', async () => {
      const result = await runDetailPage(loadEbikeshopCapture('detail-rm-delite4-speed'));

      expect(mappedSpecs(result.rawSpecs)).toMatchObject({
        wheelSize: 27.5,
        topSpeed: 45,
        pedelecClass: 'S-Pedelec',
        frameType: 'Magas',
        gearType: 'Agyváltó',
        rearDerailleur: 'Enviolo',
        brakeModel: 'Magura ABS',
        displayModel: 'Bosch Kiox 500',
      });
      expect(mappedSpecs(result.rawSpecs)).not.toHaveProperty('gearCount');
    });

    it.each([
      ['Felhasználás módja', 'Cross', { usageType: 'Cross Trekking' }],
      ['Felhasználás módja', 'Városi', { usageType: 'City' }],
      ['Váztípus', 'Cross női', { gender: 'Női' }],
      ['Váztípus', 'Alacsony', { frameType: 'Alacsony' }],
    ])('maps %s "%s" onto the schema', async (label, value, expected) => {
      const capture = loadEbikeshopCapture('detail-ktm-exonicx-48');
      const row = productOf(capture).properties.find((candidate) => candidate.categoryTitle === label);
      if (!row) throw new Error(`the capture has a ${label} row`);
      row.value = value;

      const result = await runDetailPage(capture);

      expect(mappedSpecs(result.rawSpecs)).toMatchObject(expected);
    });
  });

  // Only the frame-size list groups sizes. Other variation axes (frame shape,
  // colour) link to the same or to different bikes, not to this bike's sizes.
  it('takes sibling ids from the frame-size variations only', async () => {
    const capture = loadEbikeshopCapture('detail-ktm-exonicx-48');
    const frameShapes = productOf(capture).variations.find((variation) => variation.type === 'frame_shape');
    frameShapes?.items.push({ label: 'Trapéz', value: 'Trapéz', selected: false, gtin: '', productCode: '1260099999' });

    const result = await runDetailPage(capture);

    expect(result.siblingIds).not.toContain('1260099999');
  });

  it('reports no siblings and no barcode for a single-size bike without one', async () => {
    const result = await runDetailPage(loadEbikeshopCapture('detail-rm-delite4-speed'));

    expect(result.siblingIds).toBeUndefined();
    // The config maps a barcode; this bike has none.
    expect(result.rawOffers[0].gtin).toBeNull();
    expect(result.rawOffers[0].mpn).toBe('F01153_04013712091408');
  });

  it('falls back to the legal manufacturer name, minus its company form, when manufacturer is null', async () => {
    const capture = loadEbikeshopCapture('detail-ktm-exonicx-48');
    productOf(capture).manufacturer = null;

    const result = await runDetailPage(capture);

    // The page's legal name is "KTM Fahrrad GmbH".
    expect(result.brand).toBe('KTM Fahrrad');
  });

  it('prices a bike on sale at its sale price, with the regular price as the old one', async () => {
    const result = await runDetailPage(loadEbikeshopCapture('detail-rm-delite4-speed'));

    expect(result.rawOffers[0].price).toBe(2999000);
    // prices.price is 3319000.0041: float noise, rounded away.
    expect(result.rawOffers[0].priceWithoutDiscount).toBe(3319000);
  });

  // priceSale is 0 on every bike not on sale.
  it('prices a bike not on sale at its regular price, rounded', async () => {
    const capture = loadEbikeshopCapture('detail-cube-supreme-varhato');
    expect(productOf(capture).prices).toMatchObject({ sale: false, priceSale: 0, price: 1379990.001 });

    const result = await runDetailPage(capture);

    expect(result.rawOffers[0].price).toBe(1379990);
  });

  it('reports no old price when prices.sale is false', async () => {
    const result = await runDetailPage(loadEbikeshopCapture('detail-ktm-exonicx-48'));

    // Null, not absent: the config maps an old price and says there is none,
    // which clears one a seller's other source still carries.
    expect(result.rawOffers[0].priceWithoutDiscount).toBeNull();
  });

  it('maps JSON-LD InStock to in_stock, with the store as the location', async () => {
    const result = await runDetailPage(loadEbikeshopCapture('detail-rm-homage5-extrak'));

    expect(result.rawOffers).toHaveLength(1);
    expect(result.rawOffers[0].availability).toBe('in_stock');
    // props.product.locations: the stores holding it.
    expect(result.rawOffers[0].locations).toEqual(['Törökbálint']);
  });

  // SYNTHETIC: none of the captured bikes is out of stock (the listing does not
  // show such bikes). The shape is the one observed live earlier: JSON-LD
  // OutOfStock, and no store holding it.
  it('maps JSON-LD OutOfStock to out_of_stock, with no locations', async () => {
    const capture = loadEbikeshopCapture('detail-ktm-exonicx-48');
    capture.jsonLd = capture.jsonLd?.replace('https://schema.org/PreOrder', 'https://schema.org/OutOfStock');
    expect(productOf(capture).locations).toEqual([]);

    const result = await runDetailPage(capture);

    expect(result.rawOffers).toHaveLength(1);
    expect(result.rawOffers[0].availability).toBe('out_of_stock');
    expect(result.rawOffers[0].locations).toBeNull();
  });

  it('maps a bike awaiting production (JSON-LD PreOrder) to preorder', async () => {
    const result = await runDetailPage(loadEbikeshopCapture('detail-cube-supreme-varhato'));

    expect(result.rawOffers[0].availability).toBe('preorder');
  });

  // A bike awaiting production shows its expected date in the "Üzletek"
  // section: "Várható gyártási időpont:" and "2026. szept. 26.". The config
  // used to read that text as store names; props.product.locations is empty.
  it('reports no store for a bike awaiting production', async () => {
    const capture = loadEbikeshopCapture('detail-cube-supreme-varhato');
    expect(capture.storesHtml).toContain('Várható gyártási időpont');

    const result = await runDetailPage(capture);

    expect(result.rawOffers[0].locations).toBeNull();
  });

  // ebikeshop redirects an unknown product slug to a fuzzy-matched, unrelated
  // product — here a Powunity cable, category "bosch-alkatreszek". The config
  // used to file everything as an e-bike; without a category the detail
  // scraper imports nothing.
  it('does not file an unrelated product reached through a redirect as an e-bike', async () => {
    const result = await runDetailPage(loadEbikeshopCapture('unknown-slug-fuzzy-redirect'));

    expect(result.categorySlug).toBeUndefined();
  });

  it('finds nothing to import on a redirect to the home page', async () => {
    const result = await runDetailPage(loadEbikeshopCapture('unknown-slug-home-redirect'));

    expect(result.brand).toBeUndefined();
    expect(result.rawSpecs).toEqual([]);
    expect(result.rawOffers).toEqual([]);
  });
});
