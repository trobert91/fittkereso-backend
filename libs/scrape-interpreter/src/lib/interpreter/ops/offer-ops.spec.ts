import * as cheerio from 'cheerio';
import { makeAssembleOffer } from './offer-ops';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { registerOps } from './register-ops';
import { RawOfferRecord } from '../scrape-interpreter.service';

function makeContext(): ScrapeExecutionContext {
  const html = '<div></div>';
  return {
    $: cheerio.load(html),
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

describe('assembleOffer identifiers', () => {
  const handler = makeAssembleOffer(makeRunner());
  const assemble = async (...args: Parameters<typeof handler>) =>
    (await handler(...args)) as RawOfferRecord | undefined;
  const item = { price: 3879000, gtin: '9008594503199', productCode: '1260040108' };
  const price = [{ op: 'jsonPath' as const, path: 'price' }];

  it('reads gtin and mpn from their own sub-pipelines, as published', async () => {
    const offer = await assemble(makeContext(), item, {
      op: 'assembleOffer',
      price,
      gtin: [{ op: 'jsonPath', path: 'gtin' }],
      mpn: [{ op: 'jsonPath', path: 'productCode' }],
    });

    expect(offer).toMatchObject({ gtin: '9008594503199', mpn: '1260040108' });
  });

  // Validation happens where the value is stored (Offer.gtin), so the op only
  // locates the value — a malformed one still comes through for inspection.
  it('does not validate, leaving that to the store step', async () => {
    const offer = await assemble(makeContext(), { price: 1, gtin: '5461000' }, {
      op: 'assembleOffer',
      price,
      gtin: [{ op: 'jsonPath', path: 'gtin' }],
    });

    expect(offer?.gtin).toBe('5461000');
  });

  it('keeps a numeric JSON value as text', async () => {
    const offer = await assemble(makeContext(), { price: 1, gtin: 9008594503199 }, {
      op: 'assembleOffer',
      price,
      gtin: [{ op: 'jsonPath', path: 'gtin' }],
    });

    expect(offer?.gtin).toBe('9008594503199');
  });

  // ebikeshop publishes `gtin: ""` for sizes without a barcode. The source
  // maps the field, so "none" is what it says.
  it('reports a blank value of a configured field as null', async () => {
    const offer = await assemble(makeContext(), { price: 1, gtin: '  ' }, {
      op: 'assembleOffer',
      price,
      gtin: [{ op: 'jsonPath', path: 'gtin' }],
    });

    expect(offer?.gtin).toBeNull();
  });

  it('leaves both absent when the config does not ask for them', async () => {
    const offer = await assemble(makeContext(), item, { op: 'assembleOffer', price });

    expect(offer?.gtin).toBeUndefined();
    expect(offer?.mpn).toBeUndefined();
  });
});

describe('assembleOffer: none versus silent', () => {
  const handler = makeAssembleOffer(makeRunner());
  const assemble = async (...args: Parameters<typeof handler>) =>
    (await handler(...args)) as RawOfferRecord | undefined;
  const price = [{ op: 'jsonPath' as const, path: 'price' }];

  it('gives null for configured fields that find nothing (a sale that ended)', async () => {
    const offer = await assemble(makeContext(), { price: 1499990 }, {
      op: 'assembleOffer',
      price,
      priceWithoutDiscount: [{ op: 'jsonPath', path: 'oldPrice' }],
      currency: [{ op: 'jsonPath', path: 'currency' }],
      availability: [{ op: 'jsonPath', path: 'stock' }],
      url: [{ op: 'jsonPath', path: 'link' }],
      locations: [{ op: 'jsonPath', path: 'stores' }],
    });

    expect(offer).toMatchObject({
      price: 1499990,
      priceWithoutDiscount: null,
      currency: null,
      availability: null,
      url: null,
      locations: null,
    });
  });

  it('leaves unconfigured fields undefined, so other sources decide them', async () => {
    const offer = await assemble(makeContext(), { price: 1499990, oldPrice: 2269000 }, {
      op: 'assembleOffer',
      price,
    });

    expect(offer).toBeDefined();
    for (const field of ['priceWithoutDiscount', 'currency', 'availability', 'url', 'locations'] as const) {
      expect(offer?.[field]).toBeUndefined();
    }
  });

  it('keeps a value that is there', async () => {
    const offer = await assemble(makeContext(), { price: 1499990, oldPrice: 2269000 }, {
      op: 'assembleOffer',
      price,
      priceWithoutDiscount: [{ op: 'jsonPath', path: 'oldPrice' }],
    });

    expect(offer?.priceWithoutDiscount).toBe(2269000);
  });
});
