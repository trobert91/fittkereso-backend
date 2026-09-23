import * as cheerio from 'cheerio';
import { OfferAvailability } from '@fittkereso-backend/database';
import { jsonPath, makeAssembleListProduct } from './list-product-ops';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { registerOps } from './register-ops';

function makeContext(html = '<div></div>'): ScrapeExecutionContext {
  const $ = cheerio.load(html);
  return {
    $,
    html,
    task: {} as any,
    vars: {},
    runtime: {} as any,
    opts: {},
  };
}

/** A real runner with the real op registry, so sub-pipelines behave as in production. */
function makeRunner(): ScrapePipelineRunnerService {
  const registry = new ScrapeOpRegistryService();
  const runner = new ScrapePipelineRunnerService(registry);
  registerOps(registry, runner, {} as any);
  return runner;
}

describe('jsonPath', () => {
  const ctx = makeContext();

  it('reads a dotted path off the current pipeline value', () => {
    const item = { prices: { priceSale: 1234, price: 1500 } };
    expect(jsonPath(ctx, item, { op: 'jsonPath', path: 'prices.priceSale' })).toBe(1234);
  });

  it('returns the value itself when no path is given', () => {
    expect(jsonPath(ctx, 'plain', { op: 'jsonPath' })).toBe('plain');
  });

  it('returns undefined for a missing path rather than throwing', () => {
    expect(jsonPath(ctx, { a: 1 }, { op: 'jsonPath', path: 'b.c.d' })).toBeUndefined();
  });

  it('casts numeric strings to numbers', () => {
    expect(
      jsonPath(ctx, { p: '2465991' }, { op: 'jsonPath', path: 'p', cast: 'number' }),
    ).toBe(2465991);
  });

  it('casts a non-numeric string to undefined rather than NaN', () => {
    expect(
      jsonPath(ctx, { p: 'n/a' }, { op: 'jsonPath', path: 'p', cast: 'number' }),
    ).toBeUndefined();
  });

  // Boolean() would call all of these true, which is exactly the trap: a JSON
  // payload rendered into a DOM attribute arrives as strings.
  it.each([
    ['false', false],
    ['0', false],
    ['', false],
    ['true', true],
    ['1', true],
  ])('casts the string %p to %p', (input, expected) => {
    expect(
      jsonPath(ctx, { v: input }, { op: 'jsonPath', path: 'v', cast: 'boolean' }),
    ).toBe(expected);
  });
});

describe('assembleListProduct', () => {
  const runner = makeRunner();
  const assemble = makeAssembleListProduct(runner);

  const item = {
    showPageUrl: 'https://ebikeshop.hu/termek/macina-scarp',
    productCode: 'KTM-123',
    productName: 'KTM Macina Scarp',
    prices: { price: 1500000, priceSale: 1350000, sale: true },
  };

  it('assembles a record from per-field sub-pipelines', async () => {
    const result = await assemble(makeContext(), item, {
      op: 'assembleListProduct',
      url: [{ op: 'jsonPath', path: 'showPageUrl' }],
      externalId: [{ op: 'jsonPath', path: 'productCode' }],
      name: [{ op: 'jsonPath', path: 'productName' }],
      price: [{ op: 'jsonPath', path: 'prices.priceSale', cast: 'number' }],
      priceWithoutDiscount: [{ op: 'jsonPath', path: 'prices.price', cast: 'number' }],
      currency: [{ op: 'literal', value: 'HUF' }],
    });

    expect(result).toEqual({
      url: 'https://ebikeshop.hu/termek/macina-scarp',
      externalId: 'KTM-123',
      name: 'KTM Macina Scarp',
      price: 1350000,
      priceWithoutDiscount: 1500000,
      currency: 'HUF',
      availability: undefined,
    });
  });

  it('yields nothing when the URL does not resolve', async () => {
    const result = await assemble(makeContext(), item, {
      op: 'assembleListProduct',
      url: [{ op: 'jsonPath', path: 'nope' }],
      price: [{ op: 'jsonPath', path: 'prices.priceSale', cast: 'number' }],
    });

    // forEachItem drops undefined — an item with no URL cannot be matched to a
    // stored listing, so it can neither refresh an offer nor be enqueued.
    expect(result).toBeUndefined();
  });

  it('keeps a recognised availability value', async () => {
    const result = (await assemble(makeContext(), item, {
      op: 'assembleListProduct',
      url: [{ op: 'jsonPath', path: 'showPageUrl' }],
      availability: [{ op: 'literal', value: OfferAvailability.in_stock }],
    })) as { availability?: OfferAvailability };

    expect(result.availability).toBe(OfferAvailability.in_stock);
  });

  it('drops an unrecognised availability instead of writing "unknown"', async () => {
    // Writing `unknown` here would actively degrade whatever a detail scrape
    // established. Leaving it absent leaves the stored value untouched.
    const result = (await assemble(makeContext(), item, {
      op: 'assembleListProduct',
      url: [{ op: 'jsonPath', path: 'showPageUrl' }],
      availability: [{ op: 'literal', value: 'készleten' }],
    })) as { availability?: OfferAvailability };

    expect(result.availability).toBeUndefined();
  });

  it('omits price when the card does not expose one', async () => {
    const result = (await assemble(makeContext(), item, {
      op: 'assembleListProduct',
      url: [{ op: 'jsonPath', path: 'showPageUrl' }],
    })) as { price?: number };

    // Unlike assembleOffer, a missing price does NOT drop the item: it still
    // identifies a listing worth enqueueing a detail scrape for.
    expect(result).toBeDefined();
    expect(result.price).toBeUndefined();
  });
});
