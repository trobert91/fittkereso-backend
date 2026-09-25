import { offerExternalIdOf, storedOfferExternalId } from './offer-external-id';

describe('offerExternalIdOf', () => {
  it('takes a source-native id, trimmed', () => {
    expect(offerExternalIdOf({ externalId: ' sku-1 ', url: 'https://shop.hu/a' }, 'https://shop.hu/p')).toEqual({
      value: 'sku-1',
      native: true,
    });
  });

  it("falls back to the slug of the offer's own URL, else the page's", () => {
    expect(offerExternalIdOf({ url: 'https://shop.hu/kerekpar/ktm-macina' }, 'https://shop.hu/p').value).toBe(
      'kerekpar/ktm-macina',
    );
    expect(offerExternalIdOf({ url: null }, 'https://shop.hu/kerekpar/ktm').value).toBe('kerekpar/ktm');
  });
});

describe('storedOfferExternalId', () => {
  const record = { url: 'https://shop.hu/kerekpar/ktm-macina' };

  it('reads the id an entry was stored under', () => {
    expect(storedOfferExternalId(record, { externalId: 'raw', resolvedExternalId: 'stored' })).toBe('stored');
  });

  // Several offers on one page shared the id, so none of them has an offer by it.
  it('gives none for an entry whose id collided', () => {
    expect(storedOfferExternalId(record, { externalId: 'shared', resolvedExternalId: null })).toBeUndefined();
  });

  it('derives it for an entry stored before resolvedExternalId existed', () => {
    expect(storedOfferExternalId(record, { externalId: ' sku-1 ' })).toBe('sku-1');
    expect(storedOfferExternalId(record, {})).toBe('kerekpar/ktm-macina');
  });
});
