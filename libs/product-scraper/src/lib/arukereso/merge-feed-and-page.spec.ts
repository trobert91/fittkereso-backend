import type { ScrapedPage, ScrapedProduct } from '@fittkereso-backend/database';
import { splitDeterministicSpecs } from '../product-scraper/services/deterministic-specs';
import { mergeFeedAndPage, toScrapedPage } from './merge-feed-and-page';
import { pageContentHash } from '../product-scraper/services/product-page-reader.service';

const offerLevelKeys = ['frameSize', 'color'];

/** A mapped feed row: mangobike's 24384 as its feed has it — no specs but the year. */
const feedRow = (overrides: Partial<ScrapedProduct> = {}): ScrapedProduct => {
  const extractedSpecs = { modelYear: 2026, frameType: 'Magas' };
  const split = splitDeterministicSpecs(extractedSpecs, offerLevelKeys);
  return {
    brand: 'KTM',
    originalName: 'KTM Macina Tour PX 610 600 Wh Elektromos Trekking Kerékpár - Bright Teal Matt - kék',
    category: { id: 'cat-1', slug: 'ebikes', name: 'Ebikes' },
    externalId: '24384',
    extractedSpecs,
    specs: split.productLevelDeterministicSpecs,
    productLevelDeterministicSpecs: split.productLevelDeterministicSpecs,
    offerLevelDeterministicSpecs: split.offerLevelDeterministicSpecs,
    productSpecsHash: split.productSpecsHash,
    offerSpecsHash: split.offerSpecsHash,
    rawSpecs: [{ name: 'Webshop kategória', values: ['Elektromos Túra Kerékpárok'] }],
    description: 'The feed description',
    images: [{ url: 'https://www.mangobike.hu/_upload/images/catalog/KT-1260161111/KT-1260161111.jpg', order: 0 }],
    offers: [
      {
        externalId: '24384',
        price: 1259640,
        currency: 'HUF',
        availability: 'in_stock',
        mpn: '1260161111',
        url: 'https://www.mangobike.hu/ktm-macina-tour-px-610-kek-4',
      },
    ],
    ...overrides,
  } as ScrapedProduct;
};

/** What the page said: the 24384 page's table, mapped. */
const page = (overrides: Partial<ScrapedPage> = {}): ScrapedPage => ({
  url: 'https://www.mangobike.hu/ktm-macina-tour-px-610-kek-4',
  rawSpecs: [
    { name: 'Neme:', values: ['Férfi'] },
    { name: 'Motor típusa:', values: ['Bosch Performance Line PX (90 Nm)'] },
    { name: 'Vázméret:', values: ['51 cm'] },
  ],
  description: 'QUALITY. COMFORT. POWER. STYLE.',
  specs: { gender: 'Férfi', torque: 90, weight: 26.9, frameSize: 51, modelYear: 2025 },
  images: [{ url: 'https://www.mangobike.hu/gallery-1.jpg', order: 0 }],
  rowCount: 1,
  contentHash: 'page-hash',
  ...overrides,
});

describe('mergeFeedAndPage', () => {
  describe('the feed is primary', () => {
    it('keeps every spec the feed has, the page filling only the missing keys', () => {
      const merged = mergeFeedAndPage(feedRow(), page(), offerLevelKeys);

      // modelYear: the feed's 2026 stands against the page's 2025.
      expect(merged.extractedSpecs).toEqual({
        modelYear: 2026,
        frameType: 'Magas',
        gender: 'Férfi',
        torque: 90,
        weight: 26.9,
        frameSize: 51,
      });
      expect(merged.productLevelDeterministicSpecs).toEqual({
        modelYear: 2026,
        frameType: 'Magas',
        gender: 'Férfi',
        torque: 90,
        weight: 26.9,
      });
      expect(merged.specs).toEqual(merged.productLevelDeterministicSpecs);
      expect(merged.offerLevelDeterministicSpecs).toEqual({ frameSize: 51 });
    });

    it('recomputes both spec hashes from the merged specs', () => {
      const merged = mergeFeedAndPage(feedRow(), page(), offerLevelKeys);
      const expected = splitDeterministicSpecs(merged.extractedSpecs ?? {}, offerLevelKeys);

      expect(merged.productSpecsHash).toBe(expected.productSpecsHash);
      expect(merged.offerSpecsHash).toBe(expected.offerSpecsHash);
      expect(merged.productSpecsHash).not.toBe(feedRow().productSpecsHash);
    });

    it('never takes category, brand, title, externalId, price or stock from the page', () => {
      const row = feedRow();
      const merged = mergeFeedAndPage(row, page(), offerLevelKeys);

      expect(merged).toMatchObject({
        category: row.category,
        brand: 'KTM',
        originalName: row.originalName,
        externalId: '24384',
      });
      expect(merged.offers?.[0]).toMatchObject({ price: 1259640, availability: 'in_stock', currency: 'HUF' });
    });

    it('keeps the feed’s description and images, and takes the page’s only when the row has none', () => {
      expect(mergeFeedAndPage(feedRow(), page(), offerLevelKeys)).toMatchObject({
        description: 'The feed description',
        images: feedRow().images,
      });
      expect(
        mergeFeedAndPage(feedRow({ description: '  ', images: [] }), page(), offerLevelKeys),
      ).toMatchObject({ description: 'QUALITY. COMFORT. POWER. STYLE.', images: page().images });
    });

    it('puts the feed’s rows first, then the page’s', () => {
      const merged = mergeFeedAndPage(feedRow(), page(), offerLevelKeys);

      expect(merged.rawSpecs?.map((row) => row.name)).toEqual([
        'Webshop kategória',
        'Neme:',
        'Motor típusa:',
        'Vázméret:',
      ]);
    });

    it('stores the page on the listing', () => {
      expect(mergeFeedAndPage(feedRow(), page(), offerLevelKeys).page).toEqual(page());
    });
  });

  // A page several rows share (a bike's sizes): its size says nothing about one.
  it('leaves a shared page’s offer-level values out', () => {
    const merged = mergeFeedAndPage(feedRow(), page({ rowCount: 3 }), offerLevelKeys);

    expect(merged.offerLevelDeterministicSpecs).toEqual({});
    expect(merged.extractedSpecs).not.toHaveProperty('frameSize');
    expect(merged.extractedSpecs).toMatchObject({ gender: 'Férfi', torque: 90 });
  });

  it('keeps the feed’s own offer-level value over the page’s', () => {
    const extractedSpecs = { modelYear: 2026, frameSize: 56 };
    const merged = mergeFeedAndPage(feedRow({ extractedSpecs }), page(), offerLevelKeys);

    expect(merged.offerLevelDeterministicSpecs).toEqual({ frameSize: 56 });
  });

  it('adds nothing but the rows and the page itself when the page mapped no specs', () => {
    const merged = mergeFeedAndPage(feedRow(), page({ specs: undefined }), offerLevelKeys);

    expect(merged.extractedSpecs).toEqual(feedRow().extractedSpecs);
    expect(merged.productSpecsHash).toBe(feedRow().productSpecsHash);
    expect(merged.rawSpecs).toHaveLength(4);
  });

  describe("the row's offer", () => {
    const offer = (fields: Record<string, unknown>) => ({ externalId: '24384', price: 1259640, ...fields });

    it('fills a missing GTIN and MPN from the page offer that is this row’s', () => {
      const row = feedRow({ offers: [{ externalId: '24384', price: 1259640, gtin: null } as never] });
      const merged = mergeFeedAndPage(
        row,
        page({ offers: [offer({ gtin: '9008594507326', mpn: 'KT-1260161111' })] }),
        offerLevelKeys,
      );

      expect(merged.offers?.[0]).toMatchObject({ gtin: '9008594507326', mpn: 'KT-1260161111' });
    });

    it('keeps the feed’s own MPN over the page’s', () => {
      const merged = mergeFeedAndPage(feedRow(), page({ offers: [offer({ mpn: 'KT-OTHER' })] }), offerLevelKeys);

      expect(merged.offers?.[0].mpn).toBe('1260161111');
    });

    // mangobike's feed has no old price; its page shows one on discounted bikes.
    it('fills the old price while the feed price is still the price the page showed', () => {
      const merged = mergeFeedAndPage(
        feedRow(),
        page({ offers: [offer({ priceWithoutDiscount: 1399000 })] }),
        offerLevelKeys,
      );

      expect(merged.offers?.[0].priceWithoutDiscount).toBe(1399000);
    });

    // The discount ended: the feed price moved, so the page's old price is stale.
    it('drops the page’s old price once the feed price differs from the page’s', () => {
      const merged = mergeFeedAndPage(
        feedRow(),
        page({ offers: [offer({ price: 1199000, priceWithoutDiscount: 1399000 })] }),
        offerLevelKeys,
      );

      expect(merged.offers?.[0].priceWithoutDiscount).toBeUndefined();
    });

    // null: the feed maps an old price and says there is none — that stands.
    it('keeps the feed’s own "no old price"', () => {
      const row = feedRow({ offers: [{ externalId: '24384', price: 1259640, priceWithoutDiscount: null }] });
      const merged = mergeFeedAndPage(row, page({ offers: [offer({ priceWithoutDiscount: 1399000 })] }), offerLevelKeys);

      expect(merged.offers?.[0].priceWithoutDiscount).toBeNull();
    });

    it("matches the page's offer by the row's id on a shared page", () => {
      const row = feedRow({ externalId: 'SC_L', offers: [{ externalId: 'SC_L', price: 1000 }] });
      const merged = mergeFeedAndPage(
        row,
        page({
          rowCount: 3,
          offers: [
            { externalId: 'SC_M', price: 1000, gtin: 'gtin-M' },
            { externalId: 'SC_L', price: 1000, gtin: 'gtin-L' },
          ],
        }),
        offerLevelKeys,
      );

      expect(merged.offers?.[0].gtin).toBe('gtin-L');
    });

    it('uses no page offer on a shared page when none is the row’s', () => {
      const row = feedRow({ externalId: 'SC_XL', offers: [{ externalId: 'SC_XL', price: 1000 }] });
      const merged = mergeFeedAndPage(
        row,
        page({ rowCount: 3, offers: [{ externalId: 'SC_M', price: 1000, gtin: 'gtin-M' }] }),
        offerLevelKeys,
      );

      expect(merged.offers?.[0].gtin).toBeUndefined();
    });

    it("takes a one-row page's only offer as the row's", () => {
      const merged = mergeFeedAndPage(feedRow(), page({ offers: [{ price: 1259640, gtin: '9008' }] }), offerLevelKeys);

      expect(merged.offers?.[0].gtin).toBe('9008');
    });
  });

  it('takes the page’s siblings only when the page’s ids are the row’s', () => {
    expect(
      mergeFeedAndPage(feedRow(), page({ externalId: '24384', siblingExternalIds: ['24385'] }), offerLevelKeys)
        .siblingExternalIds,
    ).toEqual(['24385']);
    expect(
      mergeFeedAndPage(feedRow(), page({ externalId: 'KT-1260161111', siblingExternalIds: ['x'] }), offerLevelKeys)
        .siblingExternalIds,
    ).toBeUndefined();
  });

  // What makes a feed-only import after the read cost no LLM call.
  it('gives the same listing from the stored page as from the fresh read', () => {
    const fresh = mergeFeedAndPage(feedRow(), page(), offerLevelKeys);
    const stored = mergeFeedAndPage(feedRow(), JSON.parse(JSON.stringify(page())), offerLevelKeys);

    expect(stored).toEqual(fresh);
  });
});

describe('toScrapedPage', () => {
  const read = (detail: Record<string, unknown> = {}, specs?: Record<string, unknown>) => {
    const full = {
      rawSpecs: [{ name: 'Neme:', values: ['Férfi'] }],
      description: '  QUALITY.  ',
      imageUrls: ['https://shop.hu/a.jpg', 'https://shop.hu/b.jpg'],
      rawOffers: [{ externalId: 'SC_M', price: 1000, priceWithoutDiscount: 1200, availability: 'in_stock' }],
      offerLinks: [],
      ...detail,
    };
    return {
      url: 'https://shop.hu/p',
      fetchMode: 'direct' as const,
      detail: full as never,
      specs,
      contentHash: pageContentHash(full as never),
    };
  };

  it('keeps what a later feed-only import merges in again', () => {
    expect(toScrapedPage(read({}, { gender: 'Férfi' }) as never, 2)).toEqual({
      url: 'https://shop.hu/p',
      rawSpecs: [{ name: 'Neme:', values: ['Férfi'] }],
      description: 'QUALITY.',
      specs: { gender: 'Férfi' },
      images: [
        { url: 'https://shop.hu/a.jpg', order: 0 },
        { url: 'https://shop.hu/b.jpg', order: 1 },
      ],
      // The page's stock is never kept: it goes stale, and the feed has it.
      offers: [{ externalId: 'SC_M', price: 1000, priceWithoutDiscount: 1200 }],
      rowCount: 2,
      contentHash: expect.any(String),
    });
  });

  it('leaves out what the page did not have', () => {
    const scraped = toScrapedPage(read({ description: undefined, imageUrls: [], rawOffers: [] }, {}) as never, 1);

    expect(Object.keys(scraped).sort()).toEqual(['contentHash', 'rawSpecs', 'rowCount', 'url']);
  });
});
