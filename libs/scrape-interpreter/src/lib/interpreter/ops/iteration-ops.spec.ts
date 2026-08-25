import * as cheerio from 'cheerio';
import { makeForEachItem } from './iteration-ops';
import { ScrapeOpRegistryService } from '../services/scrape-op-registry.service';
import { ScrapePipelineRunnerService } from '../services/scrape-pipeline-runner.service';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';
import { ForEachItemOp } from '@fittkereso-backend/database';

function makeContext(
  $: cheerio.CheerioAPI,
  vars: Record<string, unknown> = {},
): ScrapeExecutionContext {
  return { $, html: '', task: {} as never, vars, runtime: {} as never, opts: {} };
}

describe('forEachItem', () => {
  it('does not leak an `as`-stored value from one item into the next (per-item vars isolation)', async () => {
    // Each item's pipeline stashes an `onSale` value under `as`, then a
    // later op in the SAME item's pipeline reads it back. If vars were
    // shared across iterations (not cloned), item 2 would incorrectly see
    // item 1's leftover `onSale` value whenever its own pipeline didn't set
    // one first.
    const $ = cheerio.load(`
      <div class="row" data-on-sale="true"></div>
      <div class="row"></div>
    `);
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);

    registry.register('readOnSaleAttr' as never, (ctx, input) => {
      const el = input as cheerio.Cheerio<never>;
      const attr = el.attr('data-on-sale');
      // undefined (not false) when the attribute is absent — mirrors a real
      // op that only produces a value when there's something to extract
      // (e.g. selectAttr returns undefined for a missing attribute).
      return attr === undefined ? undefined : attr === 'true';
    });
    registry.register('storeAsIfDefined' as never, (ctx, input, op: any) => {
      // Mirrors OpBase.as semantics (ScrapePipelineRunnerService only sets
      // vars[op.as] when the op actually ran — here modeled explicitly):
      // only stores into vars when this item's own pipeline produced a
      // value, so item 2 (no attribute) never writes `onSale` itself.
      if (input !== undefined) ctx.vars[op.name] = input;
      return input;
    });
    registry.register('readOnSaleVar' as never, (ctx) => {
      return ctx.vars['onSale'];
    });

    const forEachItem = makeForEachItem(runner);
    const ctx = makeContext($, {});
    const rows = $('.row');

    const op: ForEachItemOp = {
      op: 'forEachItem',
      itemMode: 'cheerio',
      itemPipeline: [
        { op: 'readOnSaleAttr' as never },
        { op: 'storeAsIfDefined' as never, name: 'onSale' } as never,
        { op: 'readOnSaleVar' as never },
      ],
      skipEmptyResults: false,
    };

    const results = await forEachItem(ctx, rows, op);

    // Item 1 sets onSale=true and reads it back -> true.
    // Item 2 never sets onSale itself -> should read undefined, NOT item
    // 1's leftover `true`, proving vars were cloned per iteration.
    expect(results).toEqual([true, undefined]);
  });

  it('drops undefined/null results by default (skipEmptyResults)', async () => {
    const $ = cheerio.load('<div class="row"></div><div class="row"></div>');
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    let call = 0;
    registry.register('maybeUndefined' as never, () => {
      call += 1;
      return call === 1 ? undefined : 'value';
    });

    const forEachItem = makeForEachItem(runner);
    const ctx = makeContext($, {});
    const rows = $('.row');

    const results = await forEachItem(ctx, rows, {
      op: 'forEachItem',
      itemMode: 'cheerio',
      itemPipeline: [{ op: 'maybeUndefined' as never }],
    });

    expect(results).toEqual(['value']);
  });

  it('keeps undefined/null results when skipEmptyResults is false', async () => {
    const $ = cheerio.load('<div class="row"></div><div class="row"></div>');
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    let call = 0;
    registry.register('maybeUndefined' as never, () => {
      call += 1;
      return call === 1 ? undefined : 'value';
    });

    const forEachItem = makeForEachItem(runner);
    const ctx = makeContext($, {});
    const rows = $('.row');

    const results = await forEachItem(ctx, rows, {
      op: 'forEachItem',
      itemMode: 'cheerio',
      itemPipeline: [{ op: 'maybeUndefined' as never }],
      skipEmptyResults: false,
    });

    expect(results).toEqual([undefined, 'value']);
  });

  it('exposes each json-mode item directly under vars[itemVar] and vars[indexVar]', async () => {
    const $ = cheerio.load('<div></div>');
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registry.register('readItemAndIndex' as never, (ctx) => {
      return { item: ctx.vars['item'], index: ctx.vars['itemIndex'] };
    });

    const forEachItem = makeForEachItem(runner);
    const ctx = makeContext($, {});

    const results = await forEachItem(ctx, ['a', 'b', 'c'], {
      op: 'forEachItem',
      itemMode: 'json',
      itemPipeline: [{ op: 'readItemAndIndex' as never }],
    });

    expect(results).toEqual([
      { item: 'a', index: 0 },
      { item: 'b', index: 1 },
      { item: 'c', index: 2 },
    ]);
  });

  it('respects custom itemVar/indexVar names', async () => {
    const $ = cheerio.load('<div></div>');
    const registry = new ScrapeOpRegistryService();
    const runner = new ScrapePipelineRunnerService(registry);
    registry.register('readCustomVars' as never, (ctx) => ({
      value: ctx.vars['offer'],
      idx: ctx.vars['offerIndex'],
    }));

    const forEachItem = makeForEachItem(runner);
    const ctx = makeContext($, {});

    const results = await forEachItem(ctx, ['x'], {
      op: 'forEachItem',
      itemMode: 'json',
      itemVar: 'offer',
      indexVar: 'offerIndex',
      itemPipeline: [{ op: 'readCustomVars' as never }],
    });

    expect(results).toEqual([{ value: 'x', idx: 0 }]);
  });
});
