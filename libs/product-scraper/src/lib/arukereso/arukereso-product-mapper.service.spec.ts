import * as fs from 'fs';
import * as path from 'path';
import { ArukeresoProductMapperService } from './arukereso-product-mapper.service';
import { ArukeresoFeedItem } from './arukereso-feed-item';
import { ArukeresoFeedParserService } from './arukereso-feed-parser.service';
import type { ArukeresoSourceConfig, ScrapedProduct } from '@fittkereso-backend/database';
import { OfferAvailability } from '@fittkereso-backend/database';
import {
  ProductValueMapperService,
  ScrapeInterpreterModule,
  ScrapeInterpreterService,
  ScrapeOpRegistryService,
  ScrapePipelineRunnerService,
} from '@fittkereso-backend/scrape-interpreter';
import { hashSpecs } from '@fittkereso-backend/utils';

describe('ArukeresoProductMapperService', () => {
  let mapper: ArukeresoProductMapperService;
  let interpreter: {
    runValuePipeline: jest.Mock;
    resolveCategoryFromRules: jest.Mock;
  };
  let runtime: { getCategoryBySlug: jest.Mock };
  let categoryConfigService: { getConfig: jest.Mock; getJsonSchema: jest.Mock };
  let specExtraction: { extractSpecs: jest.Mock };

  const config = (overrides: Partial<ArukeresoSourceConfig> = {}) =>
    ({
      baseUrl: 'https://speedbike.hu',
      feedUrl: 'https://speedbike.hu/api/?route=export/feed&id=arukereso',
      categories: { ebikes: { enabled: true } },
      category: { slugLookup: [{ when: { always: true }, slug: 'ebikes' }] },
      mapping: {
        externalId: { field: 'sku' },
        brand: { field: 'manufacturer' },
        name: { field: 'name' },
        url: { field: 'product_url' },
        price: { field: 'price' },
        imageUrl: { field: 'image_url' },
        categoryLabel: { field: 'category' },
      },
      ...overrides,
    }) as ArukeresoSourceConfig;

  const item = (
    fields: Record<string, string> = {},
    attributes: { name: string; value: string }[] = [],
  ): ArukeresoFeedItem => ({
    fields: {
      sku: 'SKU-1',
      manufacturer: 'KTM',
      name: 'KTM Macina Scarp SX Prestige Di2 M/43 Olive Pearl',
      producturl: 'https://speedbike.hu/ktm-macina-scarp',
      price: '1 299 000',
      imageurl: 'https://speedbike.hu/img/1.jpg',
      category: 'Termékkategóriák > E-BIKE > Trekking',
      ...fields,
    },
    attributes,
  });

  const call = (cfg = config(), feedItem = item(), requestedSlugs?: string[]) =>
    mapper.map({ config: cfg, item: feedItem, requestedSlugs });

  beforeEach(() => {
    interpreter = {
      runValuePipeline: jest.fn(),
      resolveCategoryFromRules: jest.fn().mockReturnValue('ebikes'),
    };
    runtime = {
      getCategoryBySlug: jest
        .fn()
        .mockResolvedValue({ id: 'cat-1', slug: 'ebikes', name: 'Ebikes' }),
    };
    categoryConfigService = {
      getConfig: jest.fn().mockReturnValue({ offerLevelSpecs: ['frameSize'] }),
      getJsonSchema: jest
        .fn()
        .mockReturnValue({ type: 'object', title: 'E-bike', properties: {} }),
    };
    specExtraction = { extractSpecs: jest.fn().mockReturnValue({}) };
    mapper = new ArukeresoProductMapperService(
      interpreter as any,
      runtime as any,
      categoryConfigService as any,
      specExtraction as any,
    );
  });

  it('produces the same shape a detail-page scrape produces', async () => {
    const result = await call();

    expect(result.status).toBe('mapped');
    if (result.status !== 'mapped') return;

    expect(result.scrapedProduct).toMatchObject({
      brand: 'KTM',
      // The raw marketing title survives as originalName whatever the
      // post-process pass does to `model` — the feed's `name` is the only
      // place the shop's own wording exists.
      originalName: 'KTM Macina Scarp SX Prestige Di2 M/43 Olive Pearl',
      externalId: 'SKU-1',
      category: { id: 'cat-1', slug: 'ebikes', name: 'Ebikes' },
    });
    expect(result.scrapedProduct.offers).toHaveLength(1);
    expect(result.scrapedProduct.offers?.[0]).toMatchObject({
      price: 1_299_000,
      url: 'https://speedbike.hu/ktm-macina-scarp',
      externalId: 'SKU-1',
    });
  });

  // Field names travel in at least three spellings; the item here stores
  // `producturl` while the config asks for `product_url`.
  it('reads a mapped field by any spelling of its name', async () => {
    const result = await call();

    expect(result.status).toBe('mapped');
    if (result.status !== 'mapped') return;
    expect(result.url).toBe('https://speedbike.hu/ktm-macina-scarp');
  });

  it('canonicalizes the product URL, dropping the feed tracking query', async () => {
    const result = await call(
      config(),
      item({
        producturl:
          'https://speedbike.hu/ktm-macina-scarp?utm_source=arukereso&aku=9f2c1',
      }),
    );

    expect(result.status).toBe('mapped');
    if (result.status !== 'mapped') return;
    // Without this a feed row and the scraped page for one product would be
    // two different ProductSourceRecord identities forever.
    expect(result.url).toBe('https://speedbike.hu/ktm-macina-scarp');
  });

  describe('offer identifiers', () => {
    const withIdentifiers = (mpnPipeline?: unknown[]) =>
      config({
        mapping: {
          ...config().mapping,
          gtin: { field: 'ean_code' },
          mpn: mpnPipeline
            ? { field: 'sku', pipeline: mpnPipeline as never }
            : { field: 'sku' },
        },
      });

    it('puts the GTIN and MPN on the offer as published', async () => {
      const result = await call(
        withIdentifiers(),
        item({ eancode: '9008594503199', sku: '1260040108' }),
      );

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0]).toMatchObject({
        gtin: '9008594503199',
        mpn: '1260040108',
      });
    });

    // speedbike sometimes prefixes KTM's article number with "MX"; the config's
    // pipeline removes it before the value reaches the offer.
    it('runs the mapping pipeline, so a shop quirk is cleaned in config', async () => {
      interpreter.runValuePipeline.mockImplementation(async (_pipeline, raw) =>
        String(raw).replace(/^MX/, ''),
      );

      const result = await call(
        withIdentifiers([{ op: 'stripPattern', pattern: '^MX' }]),
        item({ sku: 'MX1260040108' }),
      );

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].mpn).toBe('1260040108');
    });

    // Mapped but empty is the source saying "none", which another source of
    // the seller may not override.
    it('gives null when the feed row has none', async () => {
      const result = await call(withIdentifiers(), item({ eancode: '', sku: '' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].gtin).toBeNull();
      expect(result.scrapedProduct.offers?.[0].mpn).toBeNull();
    });

    it('leaves them absent when the config does not map them', async () => {
      const result = await call(config(), item({ eancode: '9008594503199' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].gtin).toBeUndefined();
      expect(result.scrapedProduct.offers?.[0].mpn).toBeUndefined();
    });
  });

  describe('the old price: none versus silent', () => {
    const withOldPrice = config({
      mapping: { ...config().mapping, priceWithoutDiscount: { field: 'old_price' } },
    });

    it('reads it when the row has one', async () => {
      const result = await call(withOldPrice, item({ oldprice: '2 269 000' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].priceWithoutDiscount).toBe(2_269_000);
    });

    // A sale that ended: Google's row has no sale price any more, and that must
    // clear the old price rather than leave it to another source.
    it('gives null when mapped and the row has none', async () => {
      const result = await call(withOldPrice, item({ oldprice: '' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].priceWithoutDiscount).toBeNull();
    });

    // The Árukereső feed has no old-price field, so it never speaks for one.
    it('leaves it absent when not mapped', async () => {
      const result = await call(config(), item({ oldprice: '2 269 000' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].priceWithoutDiscount).toBeUndefined();
      expect(result.scrapedProduct.offers?.[0].currency).toBeUndefined();
    });
  });

  describe('fallback lists', () => {
    const fallbackPrice = config({
      mapping: {
        ...config().mapping,
        price: [{ field: 'sale_price' }, { field: 'price' }],
        priceWithoutDiscount: [{ field: 'list_price' }, { field: 'old_price' }],
      },
    });

    it('takes the first entry that has a value', async () => {
      const result = await call(fallbackPrice, item({ saleprice: '899 900', price: '999 890' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].price).toBe(899_900);
    });

    it('moves past an empty entry to the next', async () => {
      const result = await call(fallbackPrice, item({ saleprice: ' ', price: '999 890', oldprice: '1 100 000' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].price).toBe(999_890);
      expect(result.scrapedProduct.offers?.[0].priceWithoutDiscount).toBe(1_100_000);
    });

    // Mapped, so the source says "none" when no entry has a value.
    it('gives null for a mapped target none of whose entries has a value', async () => {
      const result = await call(fallbackPrice, item({ saleprice: '', price: '999 890' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].priceWithoutDiscount).toBeNull();
      expect(mapper.isMapped(fallbackPrice, 'priceWithoutDiscount')).toBe(true);
    });

    it('runs each entry through its own pipeline', async () => {
      interpreter.runValuePipeline.mockImplementation(async (_pipeline, value) =>
        value === undefined ? undefined : `${value}0`,
      );
      const piped = config({
        mapping: {
          ...config().mapping,
          price: [
            { field: 'sale_price', pipeline: [{ op: 'trim' }] },
            { field: 'price', pipeline: [{ op: 'trim' }] },
          ],
        },
      } as never);

      const result = await call(piped, item({ saleprice: '89 990', price: '99 999' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].price).toBe(899_900);
    });
  });

  describe('prices, as Árukereső and Hungarian shops actually write them', () => {
    it.each([
      ['1 299 000', 1_299_000],
      ['1299000', 1_299_000],
      // Which separator is the decimal point cannot be decided by the
      // separator itself — Hungarian shops group with dots and Árukereső's own
      // examples use a comma decimal — only by how many digits follow it.
      ['379,97', 379.97],
      ['379.97', 379.97],
      ['1299.5', 1299.5],
      ['1.299.000', 1_299_000],
      ['1,299,000', 1_299_000],
      ['not a price', undefined],
    ])('reads %s as %s', async (raw, expected) => {
      if (expected === undefined) {
        expect(await call(config(), item({ price: String(raw) }))).toEqual({
          status: 'skipped',
          reason: 'missing_price',
        });
        return;
      }
      const result = await call(config(), item({ price: raw }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].price).toBe(expected);
    });
  });

  describe('the attribute table', () => {
    it('hands the feed attributes to spec extraction as raw spec rows', async () => {
      const cfg = config({
        specMapping: { ebikes: { mappings: [] } } as any,
      });

      await call(
        cfg,
        item({}, [
          { name: 'Motor', value: 'Bosch Performance CX' },
          { name: 'Váz méret', value: '43' },
        ]),
      );

      expect(specExtraction.extractSpecs).toHaveBeenCalledWith(
        expect.objectContaining({
          scrapedSpecs: [
            { name: 'Motor', values: ['Bosch Performance CX'] },
            { name: 'Váz méret', values: ['43'] },
          ],
        }),
      );
    });

    it('skips extraction entirely when the category has no specMapping', async () => {
      await call();

      expect(specExtraction.extractSpecs).not.toHaveBeenCalled();
    });
  });

  describe('the category gate', () => {
    // A feed is the whole catalogue — 1398 of speedbike's 3488 products are
    // not e-bikes — so this gate is the only thing keeping them out.
    it('skips an item whose category is not enabled', async () => {
      interpreter.resolveCategoryFromRules.mockReturnValue('scooters');

      expect(await call()).toEqual({
        status: 'skipped',
        reason: 'category_not_enabled',
      });
    });

    it('skips an item whose category no rule matched', async () => {
      interpreter.resolveCategoryFromRules.mockReturnValue(undefined);

      expect(await call()).toEqual({
        status: 'skipped',
        reason: 'category_not_identified',
      });
    });

    it('skips a category the run did not ask for', async () => {
      expect(await call(config(), item(), ['bikes'])).toEqual({
        status: 'skipped',
        reason: 'category_not_requested',
      });
    });

    it('passes the feed attributes to the lookup rules, so specValueIncludes works', async () => {
      await call(config(), item({}, [{ name: 'Motor', value: 'Bosch' }]));

      expect(interpreter.resolveCategoryFromRules).toHaveBeenCalledWith(
        expect.anything(),
        'Termékkategóriák > E-BIKE > Trekking',
        [{ name: 'Motor', values: ['Bosch'] }],
      );
    });

    it('runs labelFrom over the raw category value before matching', async () => {
      interpreter.runValuePipeline.mockResolvedValueOnce('E-BIKE');
      const cfg = config({
        category: {
          labelFrom: [{ op: 'splitAndTake', separator: ' > ', index: 1 }],
          slugLookup: [{ when: { equalsIgnoreCase: 'E-BIKE' }, slug: 'ebikes' }],
        } as any,
      });

      await call(cfg);

      expect(interpreter.resolveCategoryFromRules).toHaveBeenCalledWith(
        expect.anything(),
        'E-BIKE',
        expect.anything(),
      );
    });
  });

  describe('items that cannot become a product', () => {
    it.each([
      ['producturl', 'missing_url'],
      ['manufacturer', 'missing_brand'],
      ['name', 'missing_name'],
      ['price', 'missing_price'],
    ])('skips with %s empty, reporting %s', async (field, reason) => {
      const result = await call(config(), item({ [field]: '' }));

      expect(result).toEqual({ status: 'skipped', reason });
    });
  });

  describe('availability', () => {
    it('maps a recognised value straight through', async () => {
      const cfg = config({
        mapping: {
          ...config().mapping,
          availability: { field: 'delivery_time' },
        },
      });

      const result = await call(
        cfg,
        item({ deliverytime: 'out_of_stock' }),
      );

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].availability).toBe(
        OfferAvailability.out_of_stock,
      );
    });

    // The one case that does NOT fall back to in_stock: the feed carried more
    // specific information and we failed to read it. Defaulting here would bury
    // a config bug under a plausible-looking value; `unknown` surfaces it, and
    // a config that genuinely wants the default says so with its own mapValue
    // `default`.
    it('reports an unrecognised value as unknown rather than defaulting', async () => {
      const cfg = config({
        mapping: {
          ...config().mapping,
          availability: { field: 'delivery_time' },
        },
      });

      const result = await call(cfg, item({ deliverytime: '3-5 munkanap' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].availability).toBe(
        OfferAvailability.unknown,
      );
    });

    // Being in the feed IS the signal: a shop generates its feed from what it
    // is currently offering, so presence means buyable. This is the one place
    // the feed path deliberately differs from the scraping path, where a
    // product page exists whether or not the thing is orderable.
    it('treats presence in the feed as in stock when nothing maps to availability', async () => {
      const result = await call();

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].availability).toBe(
        OfferAvailability.in_stock,
      );
    });

    it('treats an empty availability field the same way', async () => {
      // speedbike's feed leaves delivery_time empty on all 3486 products, so
      // this is the case every one of its offers actually takes.
      const cfg = config({
        mapping: {
          ...config().mapping,
          availability: { field: 'delivery_time' },
        },
      });

      const result = await call(cfg, item({ deliverytime: '' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].availability).toBe(
        OfferAvailability.in_stock,
      );
    });

    it('lets the feed override the default when it does say something', async () => {
      const cfg = config({
        mapping: {
          ...config().mapping,
          availability: {
            field: 'delivery_time',
            // Árukereső's documented "not orderable" marker.
            pipeline: [
              {
                op: 'mapValue',
                cases: { NO: 'out_of_stock' },
                default: 'in_stock',
              },
            ],
          },
        },
      });
      interpreter.runValuePipeline.mockResolvedValueOnce('out_of_stock');

      const result = await call(cfg, item({ deliverytime: 'NO' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].availability).toBe(
        OfferAvailability.out_of_stock,
      );
    });
  });

  // Whether a listing needs an LLM call depends on whether it was seen
  // before, which only identity resolution knows — so the mapper never makes
  // one, and hands the updater everything the decision needs.
  describe('deterministic data only', () => {
    it('keeps the raw title as the model, for the identity extraction to clean', async () => {
      const result = await call();

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct).toMatchObject({
        model: 'KTM Macina Scarp SX Prestige Di2 M/43 Olive Pearl',
        originalName: 'KTM Macina Scarp SX Prestige Di2 M/43 Olive Pearl',
        displayName: 'KTM KTM Macina Scarp SX Prestige Di2 M/43 Olive Pearl',
      });
      expect(result.scrapedProduct.nameCleaned).toBeUndefined();
    });

    it('carries the split deterministic specs and both hashes', async () => {
      specExtraction.extractSpecs.mockReturnValueOnce({ weight: 24, frameSize: 43 });

      const result = await call(config({ specMapping: { ebikes: { mappings: [] } } }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct).toMatchObject({
        specs: { weight: 24 },
        extractedSpecs: { weight: 24, frameSize: 43 },
        offerLevelDeterministicSpecs: { frameSize: 43 },
        productLevelDeterministicSpecs: { weight: 24 },
        offerSpecsHash: hashSpecs({ frameSize: 43 }),
        productSpecsHash: hashSpecs({ weight: 24 }),
      });
      // Listing-level values are filled in once the extraction has read them.
      expect(result.scrapedProduct.offers?.[0].specs).toBeUndefined();
    });

    // The shared persistence path derives the slug fallback, so that a
    // scraping source and a feed source for one shop land on one identity.
    it('leaves an offer without a source-native id to the shared slug fallback', async () => {
      const result = await call(config(), item({ sku: '' }));

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.offers?.[0].externalId).toBeUndefined();
    });
  });
});

// The Google Shopping fixture, through the real parser, ops and config.
describe("ArukeresoProductMapperService on speedbike's Google Shopping feed", () => {
  const googleConfig = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        '../../../../scrape-interpreter/src/lib/interpreter/__fixtures__/speedbike-googleshop.config.json',
      ),
      'utf8',
    ),
  ) as ArukeresoSourceConfig;
  const products = new Map<string, ScrapedProduct>();

  beforeAll(async () => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    new ScrapeInterpreterModule(registry, runner, new ProductValueMapperService()).onModuleInit();
    const runtime = {
      getCategoryBySlug: jest.fn().mockResolvedValue({ id: 'cat-1', slug: 'ebikes', name: 'Ebikes' }),
    };
    const mapper = new ArukeresoProductMapperService(
      new ScrapeInterpreterService(runner, runtime as never),
      runtime as never,
      {
        getConfig: () => ({ offerLevelSpecs: [] }),
        getJsonSchema: () => ({ type: 'object', properties: {} }),
      } as never,
      { extractSpecs: () => ({}) } as never,
    );

    const items: ArukeresoFeedItem[] = [];
    await new ArukeresoFeedParserService().parseString(
      fs.readFileSync(path.join(__dirname, '__fixtures__/speedbike-google-shopping-sample.tsv'), 'utf8'),
      (feedItem) => void items.push(feedItem),
      { contentType: 'text/tab-separated-values;charset=UTF-8' },
    );
    for (const feedItem of items) {
      const mapped = await mapper.map({ config: googleConfig, item: feedItem });
      if (mapped.status !== 'mapped') throw new Error(`A fixture row was skipped: ${mapped.reason}`);
      products.set(mapped.scrapedProduct.externalId as string, mapped.scrapedProduct);
    }
  });

  const offerOf = (id: string) => products.get(id)?.offers?.[0];

  it('maps every row', () => {
    expect(products.size).toBe(6);
  });

  it('takes the sale price as the price, and the list price as the old price', () => {
    expect(offerOf('HAIBIKE-451641xx-2021')).toMatchObject({
      price: 1_499_990,
      priceWithoutDiscount: 2_269_000,
      currency: 'HUF',
      url: expect.stringMatching(/^https:\/\/speedbike\.hu\/haibike-allmtn-5[^?]*$/),
    });
    expect(offerOf('021323/2021')).toMatchObject({ price: 1_019_990, priceWithoutDiscount: 1_334_600 });
  });

  // The old price equals the price, which the offer composition drops.
  it('takes the price when there is no sale', () => {
    expect(offerOf('121210')).toMatchObject({ price: 2_149_990, priceWithoutDiscount: 2_149_990 });
  });

  it('reads the identifiers and the category off the row', () => {
    expect(offerOf('121210')).toMatchObject({ gtin: '4054571500601', mpn: '1212100578' });
    expect(products.get('121210')?.category?.slug).toBe('ebikes');
  });

  it('keeps the description, and has none where the row has none', () => {
    expect(products.get('121210')?.description).toContain('24" / 20"');
    expect(products.get('2103714104')?.description).toBeUndefined();
  });
});
