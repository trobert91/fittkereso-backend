import * as cheerio from 'cheerio';
import {
  extractAttrList,
  extractImageWithFallback,
  extractTextList,
} from './image-ops';
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

describe('extractAttrList', () => {
  it('collects an attribute from every matched element (carousel layout)', () => {
    const ctx = makeContext(`
      <div class="carousel-inner">
        <img data-lazy-delayed-src=" https://cdn.example/a.jpg " />
        <img data-lazy-delayed-src="https://cdn.example/b.jpg" />
      </div>
    `);
    const selection = ctx.$('.carousel-inner img');

    const result = extractAttrList(ctx, selection, {
      op: 'extractAttrList',
      attr: 'data-lazy-delayed-src',
      trim: true,
    });

    expect(result).toEqual([
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.jpg',
    ]);
  });
});

describe('extractTextList', () => {
  it('collects trimmed text from every matched element, in order', () => {
    const ctx = makeContext(`
      <ul class="stores">
        <li><span>  Törökbálinti raktár  </span></li>
        <li><a href="/uzletek/torokbalint">Törökbálint</a></li>
      </ul>
    `);
    const selection = ctx.$('.stores li span, .stores li a');

    const result = extractTextList(ctx, selection, { op: 'extractTextList' });

    expect(result).toEqual(['Törökbálinti raktár', 'Törökbálint']);
  });

  it('returns an empty array when the selection has no elements', () => {
    const ctx = makeContext(`<ul class="stores"></ul>`);
    const selection = ctx.$('.stores li');

    const result = extractTextList(ctx, selection, { op: 'extractTextList' });

    expect(result).toEqual([]);
  });

  it('excludes elements whose text is blank/whitespace-only', () => {
    const ctx = makeContext(`
      <ul class="stores">
        <li><span>   </span></li>
        <li><span>Győr</span></li>
      </ul>
    `);
    const selection = ctx.$('.stores li span');

    const result = extractTextList(ctx, selection, { op: 'extractTextList' });

    expect(result).toEqual(['Győr']);
  });

  it('keeps untrimmed text when trim is false, but still drops fully empty results', () => {
    const ctx = makeContext(`
      <ul class="stores">
        <li><span> Szeged </span></li>
      </ul>
    `);
    const selection = ctx.$('.stores li span');

    const result = extractTextList(ctx, selection, {
      op: 'extractTextList',
      trim: false,
    });

    expect(result).toEqual([' Szeged ']);
  });
});

describe('extractImageWithFallback', () => {
  it('prefers the primary href when it matches the CDN filter, else falls back with a replace pattern', () => {
    const ctx = makeContext(`
      <div class="product-image">
        <a class="product-image-wrapper" href="https://akcdn.net/full/a.jpg"></a>
        <img src="https://akcdn.net/mid/a-thumb.jpg" />
      </div>
      <div class="product-image">
        <a class="product-image-wrapper" href="https://other-cdn.net/full/b.jpg"></a>
        <img src="https://akcdn.net/mid/b-thumb.jpg" />
      </div>
    `);
    const boxes = ctx.$('.product-image');

    const result = extractImageWithFallback(ctx, boxes, {
      op: 'extractImageWithFallback',
      primary: {
        selector: 'a.product-image-wrapper',
        attr: 'href',
        mustContain: 'akcdn.net',
      },
      fallback: {
        selector: 'img',
        attr: 'src',
        mustContain: 'akcdn.net',
        replacePatterns: [{ from: '/mid/', to: '/full/' }],
      },
    });

    expect(result).toEqual([
      'https://akcdn.net/full/a.jpg',
      'https://akcdn.net/full/b-thumb.jpg',
    ]);
  });
});
