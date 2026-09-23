import { matchesFilter } from './source-item-filter';
import type { ProductSourceFilterConfig } from '@fittkereso-backend/database';

describe('matchesFilter', () => {
  const item: Record<string, unknown> = {
    manufacturer: 'KTM',
    name: 'KTM Macina Scarp SX Prestige',
    price: '1299000',
    sku: '',
    category: 'Termékkategóriák > E-BIKE > Trekking',
  };

  const resolve = (field: string) => item[field];
  const run = (filter: ProductSourceFilterConfig | undefined) =>
    matchesFilter(filter, resolve);

  const where = (
    conditions: ProductSourceFilterConfig['conditions'],
    rest: Partial<ProductSourceFilterConfig> = {},
  ): ProductSourceFilterConfig => ({ conditions, ...rest });

  // An unfiltered source imports everything; that is what production wants, and
  // a filter that accidentally excluded everything would be far worse than one
  // that excludes nothing.
  it('passes everything when there is no filter', () => {
    expect(run(undefined)).toBe(true);
    expect(run({ conditions: [] })).toBe(true);
  });

  describe('operators', () => {
    it.each([
      [{ field: 'manufacturer', equals: 'KTM' }, true],
      [{ field: 'manufacturer', equals: 'Cube' }, false],
      [{ field: 'manufacturer', notEquals: 'Cube' }, true],
      [{ field: 'name', contains: 'macina' }, true],
      [{ field: 'name', contains: 'cargo' }, false],
      [{ field: 'name', notContains: 'cargo' }, true],
      [{ field: 'name', matches: '^KTM .*Prestige$' }, true],
      [{ field: 'name', matches: '^Cube' }, false],
      [{ field: 'manufacturer', in: ['KTM', 'Cube'] }, true],
      [{ field: 'manufacturer', in: ['Cube', 'Giant'] }, false],
      [{ field: 'manufacturer', notIn: ['Cube'] }, true],
      [{ field: 'price', gte: 1_000_000 }, true],
      [{ field: 'price', gte: 2_000_000 }, false],
      [{ field: 'price', lt: 2_000_000 }, true],
      [{ field: 'sku', isEmpty: true }, true],
      [{ field: 'sku', isEmpty: false }, false],
      [{ field: 'manufacturer', isEmpty: false }, true],
    ])('%j -> %s', (condition, expected) => {
      expect(run(where([condition as never]))).toBe(expected);
    });

    it('combines two operators on one field as a range', () => {
      expect(
        run(where([{ field: 'price', gte: 1_000_000, lt: 1_500_000 }])),
      ).toBe(true);
      expect(
        run(where([{ field: 'price', gte: 1_000_000, lt: 1_200_000 }])),
      ).toBe(false);
    });
  });

  describe('case', () => {
    it('ignores case by default, which is almost always what is meant', () => {
      expect(run(where([{ field: 'manufacturer', equals: 'ktm' }]))).toBe(true);
    });

    it('respects case when asked', () => {
      expect(
        run(where([{ field: 'manufacturer', equals: 'ktm' }], { caseSensitive: true })),
      ).toBe(false);
    });
  });

  describe('combining conditions', () => {
    it('requires every condition by default', () => {
      expect(
        run(
          where([
            { field: 'manufacturer', equals: 'KTM' },
            { field: 'price', gte: 1_000_000 },
          ]),
        ),
      ).toBe(true);
      expect(
        run(
          where([
            { field: 'manufacturer', equals: 'KTM' },
            { field: 'price', gte: 9_000_000 },
          ]),
        ),
      ).toBe(false);
    });

    it('requires only one when match is any', () => {
      expect(
        run(
          where(
            [
              { field: 'manufacturer', equals: 'Cube' },
              { field: 'price', gte: 1_000_000 },
            ],
            { match: 'any' },
          ),
        ),
      ).toBe(true);
    });
  });

  describe('absent fields', () => {
    // "brand equals KTM" must not match a product with no brand. Every value
    // test fails closed rather than passing vacuously.
    it.each([
      [{ field: 'missing', equals: 'x' }],
      [{ field: 'missing', contains: 'x' }],
      [{ field: 'missing', matches: '.*' }],
      [{ field: 'missing', in: ['x'] }],
      [{ field: 'missing', gte: 0 }],
    ])('fails %j on an absent field', (condition) => {
      expect(run(where([condition as never]))).toBe(false);
    });

    it('treats an empty string as absent', () => {
      expect(run(where([{ field: 'sku', equals: '' }]))).toBe(false);
      expect(run(where([{ field: 'sku', isEmpty: true }]))).toBe(true);
    });

    // notEquals/notIn/notContains are satisfied by absence — "not a Cube" is
    // true of a product with no manufacturer at all.
    it('satisfies negative operators on an absent field', () => {
      expect(run(where([{ field: 'missing', notEquals: 'Cube' }]))).toBe(true);
      expect(run(where([{ field: 'missing', notIn: ['Cube'] }]))).toBe(true);
    });
  });

  describe('bad input', () => {
    // A filter that silently matched everything would import a whole catalogue
    // where ten products were asked for — so a broken pattern rejects instead.
    it('rejects the item when the regex does not compile', () => {
      expect(run(where([{ field: 'name', matches: '([unclosed' }]))).toBe(false);
    });

    it('rejects a numeric comparison against a non-numeric value', () => {
      expect(run(where([{ field: 'manufacturer', gte: 10 }]))).toBe(false);
    });

    it('reads a price with spaces or a comma decimal as a number', () => {
      const spaced = (field: string) =>
        ({ price: '1 299 000', decimal: '379,97' } as Record<string, unknown>)[
          field
        ];

      expect(
        matchesFilter(where([{ field: 'price', gte: 1_000_000 }]), spaced),
      ).toBe(true);
      expect(
        matchesFilter(where([{ field: 'decimal', lt: 400 }]), spaced),
      ).toBe(true);
    });
  });
});
