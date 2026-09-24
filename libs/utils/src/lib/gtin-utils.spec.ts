import { inspectGtin, normalizeGtin, normalizeMpn } from './gtin-utils';

describe('normalizeGtin', () => {
  // Real values from the 2026-09-23 crawl: the same KTM in both shops, and a
  // CUBE trike speedbike lists twice.
  it.each([
    ['9008594503199', '09008594503199'],
    ['4054571447913', '04054571447913'],
  ])('accepts the EAN-13 %s, padded to GTIN-14', (raw, expected) => {
    expect(normalizeGtin(raw)).toBe(expected);
  });

  it('accepts a UPC-12, and pads it so it compares equal to its EAN-13 form', () => {
    expect(normalizeGtin('036000291452')).toBe('00036000291452');
    expect(normalizeGtin('0036000291452')).toBe('00036000291452');
  });

  it('accepts a GTIN-14 and a GTIN-8 unchanged apart from padding', () => {
    expect(normalizeGtin('10012345678902')).toBe('10012345678902');
    expect(normalizeGtin('96385074')).toBe('00000096385074');
  });

  it('accepts a number, as a feed or JSON page may deliver one', () => {
    expect(normalizeGtin(9008594503199)).toBe('09008594503199');
  });

  it('ignores the separators people type into barcodes', () => {
    expect(normalizeGtin(' 900-8594-503199 ')).toBe('09008594503199');
    expect(normalizeGtin('9008594 503199')).toBe('09008594503199');
  });

  // speedbike's GIANT/LIV rows put 7-digit article stubs in ean_code.
  it('rejects an article stub that is not a GTIN length', () => {
    expect(normalizeGtin('5461000')).toBeUndefined();
  });

  it('rejects a masked placeholder', () => {
    expect(normalizeGtin('47112910603xx')).toBeUndefined();
  });

  it('rejects a flipped check digit', () => {
    expect(normalizeGtin('9008594503198')).toBeUndefined();
  });

  it('rejects all zeros, which passes the checksum', () => {
    expect(normalizeGtin('0000000000000')).toBeUndefined();
  });

  // In-store codes: every company numbers its own items from these ranges, so
  // equal values at two shops mean nothing. Both have valid check digits.
  it('rejects restricted-circulation numbers', () => {
    expect(normalizeGtin('2000000000008')).toBeUndefined(); // EAN-13 prefix 200
    expect(normalizeGtin('0400000000008')).toBeUndefined(); // EAN-13 prefix 040
    expect(normalizeGtin('200000000004')).toBeUndefined(); // UPC-12 random weight
    expect(normalizeGtin('400000000008')).toBeUndefined(); // UPC-12 in-store
  });

  it.each([undefined, null, '', '   ', {}, 1.5, -1])(
    'returns undefined for %p',
    (raw) => {
      expect(normalizeGtin(raw)).toBeUndefined();
    },
  );
});

describe('inspectGtin', () => {
  it('reports a valid GTIN with its normalized form', () => {
    expect(inspectGtin('9008594503199')).toEqual({
      gtin: '09008594503199',
      outcome: 'valid',
    });
  });

  it('tells a published non-barcode apart from nothing published', () => {
    expect(inspectGtin('5461000')).toEqual({ outcome: 'invalid' });
    expect(inspectGtin(undefined)).toEqual({ outcome: 'absent' });
    expect(inspectGtin('  ')).toEqual({ outcome: 'absent' });
  });
});

describe('normalizeMpn', () => {
  it('keeps a manufacturer article number as-is', () => {
    expect(normalizeMpn('1260040108')).toBe('1260040108');
  });

  it('drops case, whitespace and hyphens, so shops formatting one code differently agree', () => {
    expect(normalizeMpn(' 1260-040 108 ')).toBe('1260040108');
    expect(normalizeMpn('ab-12cd')).toBe('AB12CD');
  });

  it('accepts a number', () => {
    expect(normalizeMpn(1260040108)).toBe('1260040108');
  });

  it('rejects anything under 5 characters once normalized', () => {
    expect(normalizeMpn('M-43')).toBeUndefined();
    expect(normalizeMpn('12345')).toBe('12345');
  });

  it.each([undefined, null, '', '   ', {}])('returns undefined for %p', (raw) => {
    expect(normalizeMpn(raw)).toBeUndefined();
  });
});
