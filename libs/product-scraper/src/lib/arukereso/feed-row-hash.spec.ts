import {
  asFeedEntryPayload,
  FEED_HASH_VERSION,
  feedRowHash,
  stableStringify,
} from './feed-row-hash';

const product = (overrides: Record<string, unknown> = {}) =>
  ({
    brand: 'KTM',
    model: 'MACINA SCARP SX',
    specs: { modelYear: 2026, battery: 750 },
    offers: [{ externalId: '1260040108', price: 3879000, currency: 'HUF' }],
    ...overrides,
  }) as never;

describe('feedRowHash', () => {
  it('ignores key order, at every level', () => {
    const reordered = {
      offers: [{ currency: 'HUF', price: 3879000, externalId: '1260040108' }],
      specs: { battery: 750, modelYear: 2026 },
      model: 'MACINA SCARP SX',
      brand: 'KTM',
    } as never;

    expect(feedRowHash('https://speedbike.hu/p', reordered)).toBe(
      feedRowHash('https://speedbike.hu/p', product()),
    );
  });

  it('changes with anything the mapped product carries, and with the URL', () => {
    const base = feedRowHash('https://speedbike.hu/p', product());

    expect(feedRowHash('https://speedbike.hu/p', product({ specs: { modelYear: 2027, battery: 750 } }))).not.toBe(base);
    expect(
      feedRowHash('https://speedbike.hu/p', product({ offers: [{ externalId: '1260040108', price: 1, currency: 'HUF' }] })),
    ).not.toBe(base);
    expect(feedRowHash('https://speedbike.hu/q', product())).not.toBe(base);
  });

  it('treats an undefined field as absent, as the stored JSON will', () => {
    expect(feedRowHash('u', product({ description: undefined }))).toBe(feedRowHash('u', product()));
  });

  // A mapped field left empty (null) and an unmapped one (absent) mean
  // different things to the offer, so a config change between them re-imports.
  it('tells a null offer field from an absent one', () => {
    const none = product({ offers: [{ externalId: '1260040108', price: 3879000, priceWithoutDiscount: null }] });
    const silent = product({ offers: [{ externalId: '1260040108', price: 3879000 }] });

    expect(feedRowHash('u', none)).not.toBe(feedRowHash('u', silent));
  });

  // Bumped for the null/absent distinction: every row imports once more.
  it('is on version 2', () => {
    expect(FEED_HASH_VERSION).toBe(2);
  });
});

describe('stableStringify', () => {
  it('keeps array order, which is meaningful', () => {
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]));
  });
});

describe('asFeedEntryPayload', () => {
  it('accepts a stored row and rejects anything else', () => {
    const payload = { item: { fields: { identifier: '1' }, attributes: [] }, requestedSlugs: ['ebikes'] };

    expect(asFeedEntryPayload(payload)).toBe(payload);
    expect(asFeedEntryPayload(null)).toBeUndefined();
    expect(asFeedEntryPayload({ item: { fields: {} } })).toBeUndefined();
  });
});
