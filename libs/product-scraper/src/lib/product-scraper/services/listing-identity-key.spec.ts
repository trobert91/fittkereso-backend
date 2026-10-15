import type { ProductSourceRecord } from '@fittkereso-backend/database';
import {
  IDENTITY_KEY_VERSION,
  identityKeyChangeOf,
  identityKeyOf,
  isNamed,
  storedIdentityKeyOf,
} from './listing-identity-key';

const keySpecs = ['gender', 'modelYear', 'torque'];

const keyOf = (overrides: Partial<Parameters<typeof identityKeyOf>[0]> = {}) =>
  identityKeyOf({
    brand: 'KTM',
    normalizedModel: '610 macina px tour',
    identifiers: [{ gtin: '09008594503199', mpn: '1260161111' }],
    siblingIds: [],
    specs: { gender: 'Férfi', modelYear: 2026, frameSize: 51, weight: 26.9 },
    keySpecs,
    ...overrides,
  });

describe('identityKeyOf', () => {
  it('holds the brand, model, identifiers and key specs alone', () => {
    expect(keyOf()).toEqual({
      version: IDENTITY_KEY_VERSION,
      brand: 'ktm',
      normalizedModel: '610 macina px tour',
      gtins: ['09008594503199'],
      mpns: ['1260161111'],
      siblingIds: [],
      specs: { gender: 'Férfi', modelYear: 2026 },
    });
  });

  it('is the same whatever order its identifiers and specs come in', () => {
    const a = keyOf({
      identifiers: [{ mpn: 'B22222' }, { mpn: 'A11111' }, { mpn: 'A11111' }],
      siblingIds: ['2', '1'],
      specs: { modelYear: 2026, gender: 'Férfi' },
    });
    const b = keyOf({
      identifiers: [{ mpn: 'A11111' }, { mpn: 'B22222' }],
      siblingIds: ['1', '2'],
      specs: { gender: 'Férfi', modelYear: 2026 },
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('reads a brand written another way as the same', () => {
    expect(keyOf({ brand: ' ktm ' })).toEqual(keyOf());
  });

  it('leaves empty spec values out', () => {
    expect(keyOf({ specs: { gender: 'Férfi', modelYear: 2026, torque: '' } }).specs).toEqual({
      gender: 'Férfi',
      modelYear: 2026,
    });
  });
});

describe('identityKeyChangeOf', () => {
  const before = keyOf();

  it('is undefined for an equal key', () => {
    expect(identityKeyChangeOf(before, keyOf())).toBeUndefined();
  });

  it('names a key spec gained, changed or dropped', () => {
    expect(
      identityKeyChangeOf(before, keyOf({ specs: { gender: 'Női', torque: 90 } })),
    ).toEqual({ anchorsChanged: false, addedIdentifiers: [], changedSpecs: ['gender', 'modelYear', 'torque'] });
  });

  it('counts a new model as an anchor changed', () => {
    expect(identityKeyChangeOf(before, keyOf({ normalizedModel: '610 macina px sport' }))?.anchorsChanged).toBe(true);
  });

  it('counts a new brand as an anchor changed', () => {
    expect(identityKeyChangeOf(before, keyOf({ brand: 'Cube' }))?.anchorsChanged).toBe(true);
  });

  it('counts an identifier gone or replaced as an anchor changed', () => {
    const replaced = identityKeyChangeOf(
      before,
      keyOf({ identifiers: [{ gtin: '09008594503199', mpn: '1260161999' }] }),
    );
    expect(replaced).toEqual({ anchorsChanged: true, addedIdentifiers: ['1260161999'], changedSpecs: [] });
  });

  it('counts an identifier only added as no anchor changed', () => {
    expect(
      identityKeyChangeOf(
        before,
        keyOf({ identifiers: [{ gtin: '09008594503199', mpn: '1260161111' }], siblingIds: ['24385'] }),
      ),
    ).toEqual({ anchorsChanged: false, addedIdentifiers: ['24385'], changedSpecs: [] });
  });
});

describe('storedIdentityKeyOf', () => {
  const record = (fields: Record<string, unknown>) => fields as unknown as ProductSourceRecord;

  it('reads the key its record stores', () => {
    const stored = { ...keyOf(), brand: 'stored' };
    expect(
      storedIdentityKeyOf(record({ scrapedProduct: { model: 'Macina', identityKey: stored } }), keySpecs),
    ).toBe(stored);
  });

  // A record written before keys were kept is read off what it stores.
  it('reads the key off a record without one, as an import makes it', () => {
    expect(
      storedIdentityKeyOf(
        record({
          normalizedModel: '610 macina px tour',
          scrapedProduct: {
            model: 'Macina Tour PX 610',
            brand: 'KTM',
            externalId: '24384',
            siblingExternalIds: ['24384'],
            specs: { gender: 'Férfi', modelYear: 2026, frameSize: 51 },
            offers: [{ gtin: '9008594503199', mpn: '1260-161111', price: 1 }],
          },
        }),
        keySpecs,
      ),
    ).toEqual(keyOf({ specs: { gender: 'Férfi', modelYear: 2026 } }));
  });

  it('reads a key of another definition off the record again', () => {
    const old = { ...keyOf(), version: IDENTITY_KEY_VERSION - 1, brand: 'old' };
    expect(
      storedIdentityKeyOf(
        record({ normalizedModel: 'x', scrapedProduct: { model: 'X', brand: 'KTM', identityKey: old } }),
        keySpecs,
      )?.brand,
    ).toBe('ktm');
  });

  // Found by its title alone: there is nothing to compare a key with.
  it('is undefined for a record whose listing was never named', () => {
    expect(storedIdentityKeyOf(record({ scrapedProduct: { brand: 'KTM' } }), keySpecs)).toBeUndefined();
    expect(storedIdentityKeyOf(undefined, keySpecs)).toBeUndefined();
  });
});

describe('isNamed', () => {
  it('is a listing the extraction named', () => {
    expect(isNamed({ model: 'Macina' })).toBe(true);
    expect(isNamed({ model: undefined })).toBe(false);
    expect(isNamed({ model: 'Macina', flags: ['identity_failed'] })).toBe(false);
    expect(isNamed({ model: 'Macina', flags: ['identity_off'] })).toBe(false);
  });
});
