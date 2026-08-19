import { hashRawSpecs } from './raw-specs-hash';

describe('hashRawSpecs', () => {
  it('produces the same hash regardless of row-extraction order', () => {
    const a = hashRawSpecs([
      { name: 'Súly', values: ['22 kg'] },
      { name: 'Váz', values: ['Alumínium'] },
    ]);
    const b = hashRawSpecs([
      { name: 'Váz', values: ['Alumínium'] },
      { name: 'Súly', values: ['22 kg'] },
    ]);
    expect(a).toBe(b);
  });

  it('changes when a value changes', () => {
    const a = hashRawSpecs([{ name: 'Súly', values: ['22 kg'] }]);
    const b = hashRawSpecs([{ name: 'Súly', values: ['23 kg'] }]);
    expect(a).not.toBe(b);
  });

  it('changes when a spec is added or removed', () => {
    const a = hashRawSpecs([{ name: 'Súly', values: ['22 kg'] }]);
    const b = hashRawSpecs([
      { name: 'Súly', values: ['22 kg'] },
      { name: 'Váz', values: ['Alumínium'] },
    ]);
    expect(a).not.toBe(b);
  });

  it('preserves the order of values within a single spec entry (an ordered list is meaningful)', () => {
    const a = hashRawSpecs([{ name: 'Kerék', values: ['Első', 'Hátsó'] }]);
    const b = hashRawSpecs([{ name: 'Kerék', values: ['Hátsó', 'Első'] }]);
    expect(a).not.toBe(b);
  });

  it('is stable for the same input across calls', () => {
    const specs = [{ name: 'Súly', values: ['22 kg'], sectionTitle: 'General' }];
    expect(hashRawSpecs(specs)).toBe(hashRawSpecs(specs));
  });

  it('treats undefined the same as an empty array', () => {
    expect(hashRawSpecs(undefined)).toBe(hashRawSpecs([]));
  });

  it('returns a 64-character hex SHA-256 digest', () => {
    const hash = hashRawSpecs([{ name: 'Súly', values: ['22 kg'] }]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
