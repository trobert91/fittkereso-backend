import * as fs from 'fs';
import * as path from 'path';
import { ArukeresoProductMapperService } from './arukereso-product-mapper.service';
import { ArukeresoFeedItem } from './arukereso-feed-item';
import { ArukeresoFeedParserService } from './arukereso-feed-parser.service';
import type { ArukeresoSourceConfig, ScrapedProduct } from '@fittkereso-backend/database';
import { OfferAvailability, OfferCondition } from '@fittkereso-backend/database';
import {
  ProductValueMapperService,
  ScrapeInterpreterModule,
  ScrapeInterpreterService,
  ScrapeOpRegistryService,
  ScrapePipelineRunnerService,
} from '@fittkereso-backend/scrape-interpreter';
import { hashSpecs } from '@fittkereso-backend/utils';
import {
  ProductSpecNormalizationService,
  SpecExtractionService,
} from '@fittkereso-backend/product';

describe('ArukeresoProductMapperService', () => {
  let mapper: ArukeresoProductMapperService;
  let interpreter: {
    runValuePipeline: jest.Mock;
    resolveCategory: jest.Mock;
  };
  let runtime: { getCategoryBySlug: jest.Mock };
  let categoryConfigService: { getConfig: jest.Mock; getJsonSchema: jest.Mock };
  let specExtraction: { extractSpecs: jest.Mock };

  const config = (overrides: Partial<ArukeresoSourceConfig> = {}) =>
    ({
      baseUrl: 'https://speedbike.hu',
      feedUrl: 'https://speedbike.hu/api/?route=export/feed&id=arukereso',
      categories: { ebikes: { enabled: true, rules: [{ when: { always: true } }] } },
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
      resolveCategory: jest.fn().mockReturnValue({ status: 'resolved', slug: 'ebikes' }),
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
        categories: { ebikes: { enabled: true, specMapping: { mappings: [] } } },
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
      interpreter.resolveCategory.mockReturnValue({ status: 'resolved', slug: 'scooters' });

      expect(await call()).toEqual({
        status: 'skipped',
        reason: 'category_not_enabled',
      });
    });

    it('skips an item whose category no rule matched', async () => {
      interpreter.resolveCategory.mockReturnValue({ status: 'unidentified' });

      expect(await call()).toEqual({
        status: 'skipped',
        reason: 'category_not_identified',
      });
    });

    // Two sections claiming one item is a config mistake to see, not one for
    // rule order to hide.
    it('skips an item whose rules match in two category sections', async () => {
      interpreter.resolveCategory.mockReturnValue({
        status: 'ambiguous',
        slugs: ['ebikes', 'bikes'],
      });

      expect(await call()).toEqual({
        status: 'skipped',
        reason: 'category_ambiguous',
      });
    });

    it('skips a category the run did not ask for', async () => {
      expect(await call(config(), item(), ['bikes'])).toEqual({
        status: 'skipped',
        reason: 'category_not_requested',
      });
    });

    it('passes the feed attributes to the sections\' rules, so specValueIncludes works', async () => {
      await call(config(), item({}, [{ name: 'Motor', value: 'Bosch' }]));

      expect(interpreter.resolveCategory).toHaveBeenCalledWith(
        expect.anything(),
        'Termékkategóriák > E-BIKE > Trekking',
        [{ name: 'Motor', values: ['Bosch'] }],
      );
    });

    it('runs labelFrom over the raw category value before matching', async () => {
      interpreter.runValuePipeline.mockResolvedValueOnce('E-BIKE');
      const cfg = config({
        categories: { ebikes: { enabled: true, rules: [{ when: { equalsIgnoreCase: 'E-BIKE' } }] } },
        category: { labelFrom: [{ op: 'splitAndTake', separator: ' > ', index: 1 }] },
      });

      await call(cfg);

      expect(interpreter.resolveCategory).toHaveBeenCalledWith(
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

  describe('condition', () => {
    const withCondition = config({
      mapping: { ...config().mapping, condition: { field: 'condition' } },
    });
    const conditionOf = async (cfg: ArukeresoSourceConfig, feedItem: ArukeresoFeedItem) => {
      const result = await call(cfg, feedItem);
      if (result.status !== 'mapped') throw new Error(`skipped: ${result.reason}`);
      return result.scrapedProduct.offers?.[0].condition;
    };

    it.each([
      ['used', OfferCondition.used],
      ['refurbished', OfferCondition.refurbished],
      // Google's own spelling on speedbike's feed.
      ['New', OfferCondition.new],
      [' USED ', OfferCondition.used],
    ])('reads %p as %p', async (value, expected) => {
      expect(await conditionOf(withCondition, item({ condition: value }))).toBe(expected);
    });

    // Null is the source saying "none", which the offer reads as new — and
    // which, unlike silence, a lower source's "used" cannot override.
    it('gives null when mapped and the row has none', async () => {
      expect(await conditionOf(withCondition, item({ condition: '' }))).toBeNull();
    });

    it('gives null for a label the config did not translate', async () => {
      expect(await conditionOf(withCondition, item({ condition: 'Használt' }))).toBeNull();
    });

    it('leaves it absent when not mapped', async () => {
      expect(await conditionOf(config(), item({ condition: 'used' }))).toBeUndefined();
    });

    it('takes a constant for a shop that sells only used bikes', async () => {
      const usedOnly = config({
        mapping: {
          ...config().mapping,
          condition: { pipeline: [{ op: 'literal', value: 'used' }] },
        },
      });
      interpreter.runValuePipeline.mockResolvedValueOnce('used');

      expect(await conditionOf(usedOnly, item())).toBe(OfferCondition.used);
    });
  });

  // Whether a listing needs an LLM call depends on whether it was seen
  // before, which only identity resolution knows — so the mapper never makes
  // one, and hands the updater everything the decision needs.
  describe('deterministic data only', () => {
    // A title is not a model name: only the identity extraction sets one.
    it('keeps only the raw title, for the identity extraction to name', async () => {
      const result = await call();

      expect(result.status).toBe('mapped');
      if (result.status !== 'mapped') return;
      expect(result.scrapedProduct.originalName).toBe(
        'KTM Macina Scarp SX Prestige Di2 M/43 Olive Pearl',
      );
      expect(result.scrapedProduct).not.toHaveProperty('model');
      expect(result.scrapedProduct).not.toHaveProperty('flags');
    });

    it('carries the split deterministic specs and both hashes', async () => {
      specExtraction.extractSpecs.mockReturnValueOnce({ weight: 24, frameSize: 43 });

      const result = await call(
        config({ categories: { ebikes: { enabled: true, specMapping: { mappings: [] } } } }),
      );

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
  const items: ArukeresoFeedItem[] = [];
  let mapper: ArukeresoProductMapperService;

  beforeAll(async () => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    new ScrapeInterpreterModule(registry, runner, new ProductValueMapperService()).onModuleInit();
    const runtime = {
      getCategoryBySlug: jest.fn().mockResolvedValue({ id: 'cat-1', slug: 'ebikes', name: 'Ebikes' }),
    };
    mapper = new ArukeresoProductMapperService(
      new ScrapeInterpreterService(runner, runtime as never),
      runtime as never,
      {
        getConfig: () => ({ offerLevelSpecs: [] }),
        getJsonSchema: () => ({ type: 'object', properties: {} }),
      } as never,
      { extractSpecs: () => ({}) } as never,
    );

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

  it('leaves the condition to other sources while it is not mapped', () => {
    expect(offerOf('121210')?.condition).toBeUndefined();
  });

  it("reads Google's condition column as it stands once mapped", async () => {
    const withCondition = {
      ...googleConfig,
      mapping: { ...googleConfig.mapping, condition: { field: 'condition' } },
    };

    const conditions = await Promise.all(
      items.map(async (feedItem) => {
        const mapped = await mapper.map({ config: withCondition, item: feedItem });
        return mapped.status === 'mapped' ? mapped.scrapedProduct.offers?.[0].condition : undefined;
      }),
    );

    // Every row of the sample says "New".
    expect(conditions).toEqual(Array(6).fill(OfferCondition.new));
  });
});

// The ebikes brand rules (brandIdentifierSpecs) through the real ops, the
// shops' fixture configs and the category's own config and schema.
describe("ArukeresoProductMapperService reading specs off a brand's article number", () => {
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  const fixture = (shop: string) =>
    read(
      `../../../../scrape-interpreter/src/lib/interpreter/__fixtures__/${shop}-arukereso.config.json`,
    ) as ArukeresoSourceConfig;
  const ebikes = (file: string) => read(`../../../../config/src/lib/categories/ebikes/${file}`);
  let mapper: ArukeresoProductMapperService;

  beforeAll(() => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    new ScrapeInterpreterModule(registry, runner, new ProductValueMapperService()).onModuleInit();
    const runtime = {
      getCategoryBySlug: jest.fn().mockResolvedValue({ id: 'cat-1', slug: 'ebikes', name: 'Ebikes' }),
    };
    mapper = new ArukeresoProductMapperService(
      new ScrapeInterpreterService(runner, runtime as never),
      runtime as never,
      { getConfig: () => ebikes('config.json'), getJsonSchema: () => ebikes('jsonSchema.json') } as never,
      { extractSpecs: () => ({}) } as never,
    );
  });

  const map = async (shop: string, fields: Record<string, string>) => {
    const mapped = await mapper.map({ config: fixture(shop), item: { fields, attributes: [] } });
    if (mapped.status !== 'mapped') throw new Error(`skipped: ${mapped.reason}`);
    return { year: mapped.scrapedProduct.specs?.['modelYear'], mpn: mapped.scrapedProduct.offers?.[0].mpn };
  };
  const speedbike = (fields: Record<string, string>) =>
    map('speedbike', {
      manufacturer: 'KTM',
      name: 'KTM MACINA GRAN 820  US 46 Unisex elektromos trekking- túra kerékpár GREEN PURPLE FLIP MATT színben',
      producturl: 'https://speedbike.hu/ktm-macina-gran-820',
      price: '1 999 000',
      category: 'Termékkategóriák > E-BIKE > Trekking',
      sku: '',
      ...fields,
    });

  // No shop config reads KTM's year itself: each says where its article
  // number is, and the category rule reads the year off it.
  it.each([
    ['ambringa', 'KTM', { manufacturerpartnumber: '1260167141' }, 2026],
    ['ambringa', 'Giant', { manufacturerpartnumber: '2303308105' }, undefined],
    ['bikelife', 'KTM', { manufacturerpartnumber: '1260149146' }, 2026],
    [
      'mangobike',
      'KTM',
      { imageurl: 'https://www.mangobike.hu/_upload/images/catalog/KT-1260152106/KT-1260152106_bike.png' },
      2026,
    ],
  ])("reads %s's %s article number's year as %j", async (shop, brand, fields, year) => {
    const category = {
      ambringa: 'Elektromos kerékpár',
      bikelife: 'Pedelec kerékpárok',
      mangobike: 'Elektromos Kerékpárok > Elektromos Túra Kerékpárok',
    }[shop] as string;
    const mapped = await map(shop, {
      manufacturer: brand,
      name: `${brand} e-bike`,
      producturl: `https://${shop}.hu/bike`,
      price: '1 299 000',
      category,
      ...fields,
    });
    expect(mapped.year).toBe(year);
  });

  it("reads the year off KTM's 9-digit article number", async () => {
    expect(
      await map('bikelife', {
        manufacturer: 'KTM',
        name: 'KTM Macina Sport 610',
        producturl: 'https://bikelife.hu/ktm-macina-sport-610',
        price: '1 299 000',
        category: 'Pedelec kerékpárok',
        manufacturerpartnumber: '025163108',
      }),
    ).toEqual({ year: 2025, mpn: '025163108' });
  });

  // The same numbers carry KTM's frame code: the 8th digit, the 7th in the
  // 9-digit form. Its unisex mountain bikes' 6 stands for no frame type.
  it.each([
    ['1260149146', 'Magas'],
    ['1230151533', 'Alacsony'],
    ['022356206', 'Trapéz'],
    ['1260083650', undefined],
  ])("reads the frame off KTM's article number %s as %j", async (manufacturerpartnumber, frameType) => {
    const mapped = await mapper.map({
      config: fixture('bikelife'),
      item: {
        fields: {
          manufacturer: 'KTM',
          name: 'KTM Macina Style 720',
          producturl: 'https://bikelife.hu/ktm-macina-style-720',
          price: '1 299 000',
          category: 'Pedelec kerékpárok',
          manufacturerpartnumber,
        },
        attributes: [],
      },
    });
    if (mapped.status !== 'mapped') throw new Error(`skipped: ${mapped.reason}`);
    expect(mapped.scrapedProduct.specs?.['frameType']).toBe(frameType);
  });

  // speedbike leaves most KTM sku empty and writes the article number as its
  // own id; its config reads that id as the MPN only when it is a bare one.
  it("takes speedbike's bare article-number id as the MPN, and the year from it", async () => {
    expect(await speedbike({ identifier: '1260132506' })).toEqual({ year: 2026, mpn: '1260132506' });
  });

  it.each([['KTM-12501571XX-2025'], ['KTM-0223532xx-2022-F']])(
    "reads no MPN off speedbike's id %s, which is not an article number",
    async (identifier) => {
      expect(await speedbike({ identifier })).toEqual({ year: undefined, mpn: null });
    },
  );

  it("keeps speedbike's sku first", async () => {
    expect(await speedbike({ identifier: '1250167106', sku: 'MX1260167150' })).toEqual({
      year: 2026,
      mpn: '1260167150',
    });
  });

  // Cube's cargo article numbers fit KTM's 10-digit form.
  it("reads no year off another brand's article number", async () => {
    expect(await speedbike({ manufacturer: 'Cube', identifier: '1244000767' })).toEqual({
      year: undefined,
      mpn: '1244000767',
    });
  });
});

// The years bike listings state only in their feed's ids or spec rows
// (2026-10-05), read with the bikes category's rules and schema. Every
// row is let into bikes here; which rows are bikes is each shop's own setting.
describe('ArukeresoProductMapperService reading bike years from the feed', () => {
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  const bikes = (file: string) => read(`../../../../config/src/lib/categories/bikes/${file}`);
  const fixture = (shop: string) => {
    const config = read(
      `../../../../scrape-interpreter/src/lib/interpreter/__fixtures__/${shop}-arukereso.config.json`,
    ) as ArukeresoSourceConfig;
    // Every row is a bike here; the shop's own bike section keeps its mapping.
    return {
      ...config,
      categories: {
        bikes: {
          ...config.categories?.['bikes'],
          enabled: true,
          rules: [{ when: { always: true as const } }],
        },
      },
    } as ArukeresoSourceConfig;
  };
  let mapper: ArukeresoProductMapperService;

  beforeAll(() => {
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    new ScrapeInterpreterModule(registry, runner, new ProductValueMapperService()).onModuleInit();
    const runtime = {
      getCategoryBySlug: jest.fn().mockResolvedValue({ id: 'cat-2', slug: 'bikes', name: 'Bikes' }),
    };
    mapper = new ArukeresoProductMapperService(
      new ScrapeInterpreterService(runner, runtime as never),
      runtime as never,
      { getConfig: () => bikes('config.json'), getJsonSchema: () => bikes('jsonSchema.json') } as never,
      new SpecExtractionService(new ProductSpecNormalizationService()),
    );
  });

  const yearOf = async (
    shop: string,
    fields: Record<string, string>,
    attributes: { name: string; value: string }[] = [],
  ) => {
    const mapped = await mapper.map({
      config: fixture(shop),
      item: {
        fields: { name: 'bike', producturl: `https://${shop}.hu/bike`, price: '199 000', ...fields },
        attributes,
      },
    });
    if (mapped.status !== 'mapped') throw new Error(`skipped: ${mapped.reason}`);
    return mapped.scrapedProduct.specs?.['modelYear'];
  };

  it.each([
    ['bringaboard', { manufacturer: 'KTM kerékpár', sku: 'ktm-2270446215' }, 2027],
    ['bringaboard', { manufacturer: 'KTM kerékpár', sku: 'ktm-1250305113' }, 2025],
    ['bringaboard', { manufacturer: 'CTM kerékpár', sku: '224-286' }, 2024],
    ['bikelife', { manufacturer: 'KTM', manufacturerpartnumber: '2230541116' }, 2023],
    [
      'mangobike',
      { manufacturer: 'KTM', imageurl: 'https://www.mangobike.hu/_upload/images/catalog/KT-2260452119/KT-2260452119_1.jpg' },
      2026,
    ],
  ])("reads %s's article number %j as %j", async (shop, fields, year) => {
    expect(await yearOf(shop, fields)).toBe(year);
  });

  // KTM's 9-digit bike numbers disagree with the titles (kids' bikes sold for
  // years under one number); only the 10-digit forms are read.
  it("reads no year off KTM's 9-digit bike number", async () => {
    expect(await yearOf('bikelife', { manufacturer: 'KTM', manufacturerpartnumber: '021251100' })).toBeUndefined();
  });

  it("reads bringaboard's year row", async () => {
    expect(await yearOf('bringaboard', { manufacturer: 'Pells', sku: '3P23041211' }, [{ name: 'Year', value: '2024' }])).toBe(
      2024,
    );
  });

  // A year in an image file name is not read (the user's call, 2026-10-05).
  it('reads no year off a mangobike image file name', async () => {
    expect(
      await yearOf('mangobike', {
        manufacturer: 'Merida',
        imageurl: 'https://www.mangobike.hu/_upload/images/catalog/BF-2600216/BF-2600216_Merida-Silex-700-2026-piros-S.jpg',
      }),
    ).toBeUndefined();
  });
});
