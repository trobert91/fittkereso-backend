import { hashSpecs } from './spec-hash';

describe('hashSpecs', () => {
  it('produces the same hash regardless of key-insertion order', () => {
    const a = hashSpecs({ weight: 22, frameType: 'Alumínium' });
    const b = hashSpecs({ frameType: 'Alumínium', weight: 22 });
    expect(a).toBe(b);
  });

  it('changes when a value changes', () => {
    const a = hashSpecs({ weight: 22 });
    const b = hashSpecs({ weight: 23 });
    expect(a).not.toBe(b);
  });

  it('changes when a key is added or removed', () => {
    const a = hashSpecs({ weight: 22 });
    const b = hashSpecs({ weight: 22, frameType: 'Alumínium' });
    expect(a).not.toBe(b);
  });

  it('changes when an array value\'s element order changes', () => {
    const a = hashSpecs({ smartConnectivity: ['GPS', 'App'] });
    const b = hashSpecs({ smartConnectivity: ['App', 'GPS'] });
    expect(a).not.toBe(b);
  });

  it('is stable for the same input across calls', () => {
    const specs = { weight: 22, frameType: 'Alumínium' };
    expect(hashSpecs(specs)).toBe(hashSpecs(specs));
  });

  it('treats undefined the same as an empty object', () => {
    expect(hashSpecs(undefined)).toBe(hashSpecs({}));
  });

  it('returns a 64-character hex SHA-256 digest', () => {
    const hash = hashSpecs({ weight: 22 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
