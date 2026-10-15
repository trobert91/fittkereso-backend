import { canonicalizeProductUrl, normalizeUrl, slugFromUrl, urlGroupKey } from './url-utils';

describe('canonicalizeProductUrl', () => {
  // The case that forced this function to exist: the Árukereső feed ships
  // product_url already UTM-tagged, and `aku` is not stable between feed
  // generations — so without stripping the query, a feed row and the scraped
  // page for the same product are two different strings forever.
  it('drops the query string a feed appends to every product URL', () => {
    expect(
      canonicalizeProductUrl(
        'https://speedbike.hu/ktm-macina-scarp?utm_source=arukereso&utm_medium=cpp&aku=9f2c1',
      ),
    ).toBe('https://speedbike.hu/ktm-macina-scarp');
  });

  it('drops a fragment and trailing slashes', () => {
    expect(canonicalizeProductUrl('https://shop.hu/a/b/#specs')).toBe(
      'https://shop.hu/a/b',
    );
  });

  it('leaves a URL with no query or fragment alone', () => {
    expect(canonicalizeProductUrl('https://shop.hu/a/b')).toBe(
      'https://shop.hu/a/b',
    );
  });

  it('still strips a query from an unparseable, relative URL', () => {
    expect(canonicalizeProductUrl('/termek/ktm-macina?ref=hirlevel')).toBe(
      '/termek/ktm-macina',
    );
  });

  // normalizeUrl is deliberately NOT this: some configured URLs carry
  // meaningful query strings (speedbike's index.php?route=filter category
  // pages), so canonicalization is applied at product-identity sites only.
  it('is distinct from normalizeUrl, which keeps the query', () => {
    const url = 'https://speedbike.hu/index.php?route=filter&id=7';
    expect(normalizeUrl(url)).toBe(url);
    expect(canonicalizeProductUrl(url)).toBe('https://speedbike.hu/index.php');
  });
});

describe('slugFromUrl', () => {
  it('keeps the whole path, trimmed of leading and trailing slashes', () => {
    expect(
      slugFromUrl(
        'https://ebikeszalon.hu/ktm-macina-scarp-sx-prestige-di2-xl53-olive-pearl-107956',
      ),
    ).toBe('ktm-macina-scarp-sx-prestige-di2-xl53-olive-pearl-107956');
  });

  // The whole path, not the last segment: collapsing to `ktm-macina` would
  // merge the same product listed in two sections — or a used listing beside a
  // new one — onto one identity, and Offer is @Unique([seller, externalId]).
  it('keeps internal slashes, so two sections stay two identities', () => {
    expect(slugFromUrl('https://shop.hu/kerekpar/ktm-macina/')).toBe(
      'kerekpar/ktm-macina',
    );
    expect(slugFromUrl('https://shop.hu/akcio/ktm-macina')).toBe(
      'akcio/ktm-macina',
    );
  });

  it('strips the query before deriving the slug', () => {
    expect(slugFromUrl('https://shop.hu/ktm-macina?utm_source=arukereso')).toBe(
      'ktm-macina',
    );
  });

  // A single empty string as externalId would collapse EVERY such offer of a
  // seller into one row, which is silent and unrecoverable.
  it('refuses a URL with no path at all', () => {
    expect(slugFromUrl('https://shop.hu')).toBeUndefined();
    expect(slugFromUrl('https://shop.hu/')).toBeUndefined();
  });

  // Milder version of the same risk: a bare number is indistinguishable from a
  // real sku, so a slug-derived `12345` could adopt another source's listing.
  it('refuses a purely numeric path', () => {
    expect(slugFromUrl('https://shop.hu/12345')).toBeUndefined();
    expect(slugFromUrl('https://shop.hu/1/2')).toBeUndefined();
  });

  it('accepts a path that merely contains numbers', () => {
    expect(slugFromUrl('https://shop.hu/product/12345')).toBe('product/12345');
    expect(slugFromUrl('https://shop.hu/123-456-bike')).toBe('123-456-bike');
  });
});

describe('urlGroupKey', () => {
  const base = 'https://shop.hu/kerekpar/ktm-macina-tour';
  const key = urlGroupKey(base);

  // The feed rows of one product page — a bike's sizes at k2shop — must land in
  // one group however each row happens to spell the URL.
  it.each([
    ['a utm query', `${base}?utm_source=arukereso&utm_medium=cpp&aku=9f2c1`],
    ['another query', `${base}?size=M`],
    ['a fragment', `${base}#specs`],
    ['an entity-escaped query', `${base}?a=1&amp;b=2`],
    ['one trailing slash', `${base}/`],
    ['several trailing slashes', `${base}///`],
    ['http instead of https', 'http://shop.hu/kerekpar/ktm-macina-tour'],
    ['www and an upper-case host', 'HTTP://WWW.Shop.HU/kerekpar/ktm-macina-tour'],
    ['a doubled slash in the path', 'https://shop.hu/kerekpar//ktm-macina-tour'],
    ['surrounding whitespace', `  ${base}  `],
  ])('is the same with %s', (_label, variant) => {
    expect(urlGroupKey(variant)).toBe(key);
  });

  it('is the same for a raw and a percent-encoded accent', () => {
    const raw = urlGroupKey('https://shop.hu/kerékpár/x');
    expect(urlGroupKey('https://shop.hu/ker%C3%A9kp%C3%A1r/x')).toBe(raw);
    expect(urlGroupKey('https://shop.hu/ker%c3%a9kp%c3%a1r/x')).toBe(raw);
  });

  it('keeps an encoded slash inside a segment apart from a real one', () => {
    expect(urlGroupKey('https://shop.hu/a%2Fb')).not.toBe(urlGroupKey('https://shop.hu/a/b'));
  });

  // Paths are case-sensitive: two spellings may be two pages.
  it('keeps the path letter case', () => {
    expect(urlGroupKey('https://shop.hu/KTM-Macina')).not.toBe(urlGroupKey('https://shop.hu/ktm-macina'));
  });

  it.each([
    ['another page', 'https://shop.hu/kerekpar/ktm-macina-tour-2'],
    ['another section', 'https://shop.hu/akcio/ktm-macina-tour'],
    ['another host', 'https://othershop.hu/kerekpar/ktm-macina-tour'],
    ['another port', 'https://shop.hu:8443/kerekpar/ktm-macina-tour'],
  ])('tells %s apart', (_label, other) => {
    expect(urlGroupKey(other)).not.toBe(key);
  });

  it('only drops a leading www, not one inside the host', () => {
    expect(urlGroupKey('https://shopwww.hu/a')).not.toBe(urlGroupKey('https://shop.hu/a'));
  });

  it('does not throw on a relative or malformed URL, and groups it with itself', () => {
    expect(urlGroupKey('/termek/ktm?ref=x')).toBe(urlGroupKey('/termek//ktm/'));
    expect(() => urlGroupKey('https://shop.hu/%E0%A4%A')).not.toThrow();
    expect(urlGroupKey('https://shop.hu/%E0%A4%A')).toBe(urlGroupKey('https://shop.hu/%E0%A4%A/'));
  });

  // The key is only compared, never stored or fetched: the stored identity form
  // keeps the shop's own spelling.
  it('leaves canonicalizeProductUrl as it was', () => {
    expect(canonicalizeProductUrl('HTTP://WWW.Shop.HU/a/b/?x=1')).toBe('http://www.shop.hu/a/b');
  });
});
