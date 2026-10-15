import {
  asFeedEntryPayload,
  FEED_HASH_VERSION,
  feedPayloadHash,
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

  // Bumped when a mapped row stopped carrying model/displayName: every row
  // imports once more.
  it('is on version 3', () => {
    expect(FEED_HASH_VERSION).toBe(3);
  });
});

describe('stableStringify', () => {
  it('keeps array order, which is meaningful', () => {
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]));
  });
});

describe('asFeedEntryPayload', () => {
  const item = (identifier: string) => ({ fields: { identifier }, attributes: [] });

  // A page's rows: every row of one product page, a bike's sizes say.
  it('reads the rows of a page, its narrowing and its run', () => {
    const payload = {
      rows: [
        { item: item('SC_M'), listingId: 'SC_M', rowHash: 'h1' },
        { item: item('SC_L'), listingId: 'SC_L', rowHash: 'h2' },
      ],
      requestedSlugs: ['ebikes'],
      runStartedAt: '2026-10-09T02:00:00.000Z',
    };

    expect(asFeedEntryPayload(payload)).toEqual(payload);
  });

  // A task queued before rows were grouped by page carries its one row as `item`.
  it('reads a one-row payload of before rows were grouped', () => {
    expect(asFeedEntryPayload({ item: item('1'), requestedSlugs: ['ebikes'] })).toEqual({
      rows: [{ item: item('1') }],
      requestedSlugs: ['ebikes'],
      runStartedAt: undefined,
    });
  });

  it('drops a malformed row, and refuses a payload with none left', () => {
    expect(asFeedEntryPayload({ rows: [{ item: item('1') }, { item: { fields: {} } }, {}] })?.rows).toEqual([
      { item: item('1') },
    ]);
    expect(asFeedEntryPayload({ rows: [{ item: { fields: {} } }] })).toBeUndefined();
    expect(asFeedEntryPayload({ rows: [] })).toBeUndefined();
  });

  it('refuses anything else', () => {
    expect(asFeedEntryPayload(null)).toBeUndefined();
    expect(asFeedEntryPayload(undefined)).toBeUndefined();
    expect(asFeedEntryPayload({ item: { fields: {} } })).toBeUndefined();
    expect(asFeedEntryPayload({ rows: 'not rows' })).toBeUndefined();
  });
});

describe('feedPayloadHash', () => {
  // What a task carried before rows were grouped: an existing task still matches.
  it("is a one-row page's own row hash", () => {
    expect(feedPayloadHash([{ rowHash: 'h1' }])).toBe('h1');
  });

  it("ignores the order of a page's rows", () => {
    expect(feedPayloadHash([{ rowHash: 'h1' }, { rowHash: 'h2' }])).toBe(
      feedPayloadHash([{ rowHash: 'h2' }, { rowHash: 'h1' }]),
    );
  });

  it('changes with any row, or another row', () => {
    const base = feedPayloadHash([{ rowHash: 'h1' }, { rowHash: 'h2' }]);
    expect(feedPayloadHash([{ rowHash: 'h1' }, { rowHash: 'h3' }])).not.toBe(base);
    expect(feedPayloadHash([{ rowHash: 'h1' }, { rowHash: 'h2' }, { rowHash: 'h3' }])).not.toBe(base);
    expect(feedPayloadHash([{ rowHash: 'h1' }, { rowHash: 'h2' }])).not.toBe('h1');
  });

  it('is undefined for a lone row without a hash', () => {
    expect(feedPayloadHash([{}])).toBeUndefined();
  });
});
