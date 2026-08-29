import * as cheerio from 'cheerio';
import { selectText } from './selection-ops';
import { ScrapeExecutionContext } from '../interfaces/scrape-execution-context.interface';

function makeContext(html: string): ScrapeExecutionContext {
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

describe('selectText', () => {
  it('queries the page by selector when one is given', () => {
    const ctx = makeContext(`<div class="price">1 923 990 Ft</div>`);

    const result = selectText(ctx, undefined, {
      op: 'selectText',
      selector: '.price',
      trim: true,
    });

    expect(result).toBe('1 923 990 Ft');
  });

  it('reads the text of the current pipeline value when selector is omitted, for use inside a forEachItem sub-pipeline', () => {
    const ctx = makeContext(`
      <select>
        <option value="688764"> M/43 cm </option>
        <option value="704014"> L/48 cm </option>
      </select>
    `);
    const option = ctx.$('option').eq(1);

    const result = selectText(ctx, option, {
      op: 'selectText',
      trim: true,
    });

    expect(result).toBe('L/48 cm');
  });

  it('does not trim when trim is false', () => {
    const ctx = makeContext(`<option> M/43 cm </option>`);
    const option = ctx.$('option').first();

    const result = selectText(ctx, option, {
      op: 'selectText',
      trim: false,
    });

    expect(result).toBe(' M/43 cm ');
  });
});
