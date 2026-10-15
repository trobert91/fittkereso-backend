import type { ProductSourceRecord, ScrapedProduct } from '@fittkereso-backend/database';
import {
  inputPartsOf,
  specsHashOf,
  specsKeyOf,
  storedInputHashesOf,
} from './listing-input-hashes';

const offerLevelKeys = ['frameSize', 'color'];

describe('specsHashOf', () => {
  const part = (overrides: Record<string, unknown> = {}) => ({
    brand: 'KTM',
    title: 'KTM Macina Tour PX 610',
    specs: { torque: 90, weight: 26.9, frameSize: 51 },
    rawSpecs: [
      { name: 'Neme:', values: ['Férfi'] },
      { name: 'Motor típusa:', values: ['Bosch Performance Line PX (90 Nm)'] },
    ],
    description: 'QUALITY. COMFORT.',
    ...overrides,
  });
  const base = specsHashOf(part(), offerLevelKeys, 'ebikes');

  it('ignores the order of the rows', () => {
    expect(
      specsHashOf(
        part({ rawSpecs: [...part().rawSpecs].reverse() }),
        offerLevelKeys,
        'ebikes',
      ),
    ).toBe(base);
  });

  it('ignores extra whitespace in labels and values', () => {
    expect(
      specsHashOf(
        part({
          rawSpecs: [
            { name: '  Neme:  ', values: [' Férfi '] },
            { name: 'Motor   típusa:', values: ['Bosch  Performance Line PX\n(90 Nm)'] },
          ],
        }),
        offerLevelKeys,
        'ebikes',
      ),
    ).toBe(base);
  });

  // A size or a colour is the offer's, and needs no unification.
  it('ignores offer-level values', () => {
    expect(specsHashOf(part({ specs: { torque: 90, weight: 26.9, frameSize: 56 } }), offerLevelKeys, 'ebikes')).toBe(base);
  });

  it('ignores the description', () => {
    expect(specsHashOf(part({ description: 'Reworded copy.' }), offerLevelKeys, 'ebikes')).toBe(base);
  });

  it('ignores the brand and the title', () => {
    expect(specsHashOf(part({ title: 'KTM Macina Tour PX 610 (2026)', brand: 'ktm' }), offerLevelKeys, 'ebikes')).toBe(base);
  });

  it('changes with a row value', () => {
    expect(
      specsHashOf(
        part({ rawSpecs: [{ name: 'Neme:', values: ['Női'] }, part().rawSpecs[1]] }),
        offerLevelKeys,
        'ebikes',
      ),
    ).not.toBe(base);
  });

  it('changes with a row added or removed', () => {
    expect(specsHashOf(part({ rawSpecs: [part().rawSpecs[0]] }), offerLevelKeys, 'ebikes')).not.toBe(base);
  });

  it('changes with a mapped product-level value', () => {
    expect(specsHashOf(part({ specs: { torque: 85, weight: 26.9, frameSize: 51 } }), offerLevelKeys, 'ebikes')).not.toBe(base);
  });

  it('changes with the category', () => {
    expect(specsHashOf(part(), offerLevelKeys, 'bikes')).not.toBe(base);
  });

  it('keeps sections apart', () => {
    expect(
      specsHashOf(part({ rawSpecs: [{ name: 'Neme:', values: ['Férfi'], sectionTitle: 'Váz' }, part().rawSpecs[1]] }), offerLevelKeys, 'ebikes'),
    ).not.toBe(base);
  });
});

describe('specsKeyOf', () => {
  it('is the feed and the page spec content together', () => {
    expect(specsKeyOf({ feedSpecs: 'a', pageSpecs: 'b' })).toBe(specsKeyOf({ pageSpecs: 'b', feedSpecs: 'a' }));
    expect(specsKeyOf({ feedSpecs: 'a', pageSpecs: 'b' })).not.toBe(specsKeyOf({ feedSpecs: 'a' }));
    expect(specsKeyOf({ feedSpecs: 'a' })).not.toBe(specsKeyOf({ pageSpecs: 'a' }));
  });

  it('ignores the identity and unification parts', () => {
    expect(specsKeyOf({ feedSpecs: 'a', feedIdentity: 'x', unifiedSpecs: 'y' })).toBe(specsKeyOf({ feedSpecs: 'a' }));
  });
});

describe('inputPartsOf', () => {
  const listing = (overrides: Partial<ScrapedProduct> = {}) =>
    ({
      brand: 'KTM',
      originalName: 'KTM Macina',
      category: { id: '1', slug: 'ebikes', name: 'E-bikes' },
      extractedSpecs: { modelYear: 2026 },
      rawSpecs: [{ name: 'Webshop kategória', values: ['Túra'] }],
      description: 'feed',
      ...overrides,
    }) as ScrapedProduct;
  const page = { url: 'u', rawSpecs: [{ name: 'Neme:', values: ['Férfi'] }], specs: { gender: 'Férfi' }, rowCount: 1, contentHash: 'h' };

  it('makes a scraped listing its page, read now', () => {
    expect(inputPartsOf(listing(), { source: { type: 'scraping' } })).toEqual({
      page: { brand: 'KTM', title: 'KTM Macina', specs: { modelYear: 2026 }, rawSpecs: listing().rawSpecs, description: 'feed' },
      read: ['page'],
    });
  });

  it("makes a feed listing its feed row's part, from the row as mapped before its page", () => {
    const feed = listing();
    const parts = inputPartsOf(listing({ page, rawSpecs: [...(feed.rawSpecs ?? []), ...page.rawSpecs] }), {
      source: { type: 'arukereso' },
      feedListing: feed,
    });

    expect(parts.feed?.rawSpecs).toEqual(feed.rawSpecs);
    expect(parts.page).toEqual({ specs: { gender: 'Férfi' }, rawSpecs: page.rawSpecs, description: undefined });
    // The kept page is not read by a feed-only import.
    expect(parts.read).toEqual(['feed']);
  });

  it('reads both parts on an import that read the page', () => {
    const parts = inputPartsOf(listing({ page }), {
      source: { type: 'googleshop' },
      feedListing: listing(),
      pageRead: { fetchedAt: new Date() },
    });

    expect(parts.read).toEqual(['feed', 'page']);
  });

  it('reads the feed alone when the page read failed', () => {
    const parts = inputPartsOf(listing({ page }), {
      source: { type: 'arukereso' },
      feedListing: listing(),
      pageRead: { failedAt: new Date() },
    });

    expect(parts.read).toEqual(['feed']);
  });
});

describe('storedInputHashesOf', () => {
  const record = (fields: Record<string, unknown>) => fields as unknown as ProductSourceRecord;

  it('reads the stored parts', () => {
    expect(storedInputHashesOf(record({ inputHashes: { feedIdentity: 'f' } }), 'arukereso')).toEqual({ feedIdentity: 'f' });
  });

  it("reads a feed record's hash of before as its feed part", () => {
    expect(
      storedInputHashesOf(record({ inputHashes: {}, scrapedProduct: { identityInputHash: 'old' } }), 'arukereso'),
    ).toEqual({ feedIdentity: 'old' });
  });

  it("reads a scraped record's hash of before as its page part", () => {
    expect(
      storedInputHashesOf(record({ inputHashes: {}, scrapedProduct: { identityInputHash: 'old' } }), 'scraping'),
    ).toEqual({ pageIdentity: 'old' });
  });

  // Its old hash covered feed and page together: it matches neither part.
  it("does not read a feed record with a page's hash of before as any part", () => {
    expect(
      storedInputHashesOf(
        record({ inputHashes: {}, scrapedProduct: { identityInputHash: 'old', page: { url: 'u' } } }),
        'arukereso',
      ),
    ).toEqual({});
  });

  it('is empty without a record, or a hash', () => {
    expect(storedInputHashesOf(undefined, 'arukereso')).toEqual({});
    expect(storedInputHashesOf(record({ inputHashes: {}, scrapedProduct: {} }), 'arukereso')).toEqual({});
  });
});
