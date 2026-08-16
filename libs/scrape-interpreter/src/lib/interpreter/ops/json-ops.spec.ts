import * as cheerio from 'cheerio';
import {
  filterJsonArray,
  flattenJsonArray,
  mapJsonArray,
  parseJsonAttr,
} from './json-ops';
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

describe('parseJsonAttr', () => {
  it('parses a JSON attribute and walks a dot-path into it', () => {
    const payload = JSON.stringify({
      props: { product: { name: 'Macina Scarp', manufacturer: { title: 'KTM' } } },
    });
    const ctx = makeContext(`<div id="app" data-page="${escapeAttr(payload)}"></div>`);

    const result = parseJsonAttr(ctx, undefined, {
      op: 'parseJsonAttr',
      selector: '#app',
      attr: 'data-page',
      path: 'props.product.manufacturer.title',
    });

    expect(result).toBe('KTM');
  });

  it('returns the whole parsed value when no path is given', () => {
    const payload = JSON.stringify({ a: 1 });
    const ctx = makeContext(`<div id="app" data-page="${escapeAttr(payload)}"></div>`);

    const result = parseJsonAttr(ctx, undefined, {
      op: 'parseJsonAttr',
      selector: '#app',
      attr: 'data-page',
    });

    expect(result).toEqual({ a: 1 });
  });

  it('decodes HTML entities left over inside parsed JSON string values', () => {
    // Some hydration payloads (e.g. Inertia/Vue) double-encode: cheerio's
    // attr() unwraps the outer layer (making the attribute valid JSON), but
    // values inside the parsed JSON can still carry literal entities like
    // the site's own "&#39;26" (an apostrophe before a two-digit model year).
    const payload = JSON.stringify({ name: "RM Nevo5 &#39;26 kék & fekete" });
    const ctx = makeContext(`<div id="app" data-page="${escapeAttr(payload)}"></div>`);

    const result = parseJsonAttr(ctx, undefined, {
      op: 'parseJsonAttr',
      selector: '#app',
      attr: 'data-page',
      path: 'name',
    });

    expect(result).toBe("RM Nevo5 '26 kék & fekete");
  });

  it('returns undefined when the attribute is missing or the JSON is invalid', () => {
    const ctx = makeContext(`<div id="app"></div>`);
    expect(
      parseJsonAttr(ctx, undefined, {
        op: 'parseJsonAttr',
        selector: '#app',
        attr: 'data-page',
      }),
    ).toBeUndefined();

    const brokenCtx = makeContext(`<div id="app" data-page="not json"></div>`);
    expect(
      parseJsonAttr(brokenCtx, undefined, {
        op: 'parseJsonAttr',
        selector: '#app',
        attr: 'data-page',
      }),
    ).toBeUndefined();
  });
});

describe('mapJsonArray', () => {
  it('projects each array item into a plain object via dot-paths', () => {
    const ctx = makeContext('');
    const input = [
      { showPageUrl: 'https://example.com/a', productName: 'Bike A' },
      { showPageUrl: 'https://example.com/b', productName: 'Bike B' },
    ];

    const result = mapJsonArray(ctx, input, {
      op: 'mapJsonArray',
      fields: {
        url: { path: 'showPageUrl' },
        title: { path: 'productName' },
      },
    });

    expect(result).toEqual([
      { url: 'https://example.com/a', title: 'Bike A' },
      { url: 'https://example.com/b', title: 'Bike B' },
    ]);
  });

  it('interpolates a template scoped to each item, combining fields', () => {
    const ctx = makeContext('');
    const input = [
      { categoryTitle: 'Nyomaték', value: '60', quantityUnit: 'Nm' },
      { categoryTitle: 'Vázméret', value: '48', quantityUnit: '' },
    ];

    const result = mapJsonArray(ctx, input, {
      op: 'mapJsonArray',
      fields: {
        name: { path: 'categoryTitle' },
        values: {
          path: 'value',
          template: '{{value}} {{quantityUnit}}',
          asArray: true,
        },
      },
    });

    expect(result).toEqual([
      { name: 'Nyomaték', values: ['60 Nm'] },
      { name: 'Vázméret', values: ['48'] },
    ]);
  });

  it('returns an empty array when the input is not an array', () => {
    const ctx = makeContext('');
    const result = mapJsonArray(ctx, undefined, {
      op: 'mapJsonArray',
      fields: { name: { path: 'categoryTitle' } },
    });
    expect(result).toEqual([]);
  });

  it('flattens to a plain scalar array when flattenField is set', () => {
    const ctx = makeContext('');
    const input = [
      { code: 'thumb_640', url: 'https://cdn.example/a-small.jpg' },
      { code: 'original', url: 'https://cdn.example/a.jpg' },
    ];

    const result = mapJsonArray(ctx, input, {
      op: 'mapJsonArray',
      fields: { url: { path: 'url' } },
      flattenField: 'url',
    });

    expect(result).toEqual([
      'https://cdn.example/a-small.jpg',
      'https://cdn.example/a.jpg',
    ]);
  });
});

describe('filterJsonArray', () => {
  it('keeps items whose field equals the given value', () => {
    const ctx = makeContext('');
    const input = [
      { name: 'Bike A', isUsed: false },
      { name: 'Bike B', isUsed: true },
    ];

    const result = filterJsonArray(ctx, input, {
      op: 'filterJsonArray',
      path: 'isUsed',
      equals: false,
    });

    expect(result).toEqual([{ name: 'Bike A', isUsed: false }]);
  });

  it('negates the match when negate is true', () => {
    const ctx = makeContext('');
    const input = [
      { name: 'Bike A', isUsed: false },
      { name: 'Bike B', isUsed: true },
    ];

    const result = filterJsonArray(ctx, input, {
      op: 'filterJsonArray',
      path: 'isUsed',
      equals: true,
      negate: true,
    });

    expect(result).toEqual([{ name: 'Bike A', isUsed: false }]);
  });

  it('returns an empty array when the input is not an array', () => {
    const ctx = makeContext('');
    const result = filterJsonArray(ctx, undefined, {
      op: 'filterJsonArray',
      path: 'isUsed',
      equals: false,
    });
    expect(result).toEqual([]);
  });
});

describe('flattenJsonArray', () => {
  it('concatenates each item’s inner array at the given path into one flat array', () => {
    const ctx = makeContext('');
    const input = [
      { type: 'gallery', images: [{ code: 'original', url: 'a.jpg' }] },
      {
        type: 'gallery',
        images: [
          { code: 'original', url: 'b.jpg' },
          { code: 'thumb', url: 'b-thumb.jpg' },
        ],
      },
    ];

    const result = flattenJsonArray(ctx, input, {
      op: 'flattenJsonArray',
      path: 'images',
    });

    expect(result).toEqual([
      { code: 'original', url: 'a.jpg' },
      { code: 'original', url: 'b.jpg' },
      { code: 'thumb', url: 'b-thumb.jpg' },
    ]);
  });

  it('returns an empty array when the input is not an array', () => {
    const ctx = makeContext('');
    expect(
      flattenJsonArray(ctx, undefined, { op: 'flattenJsonArray', path: 'images' }),
    ).toEqual([]);
  });
});

function escapeAttr(json: string): string {
  return json.replace(/"/g, '&quot;');
}
