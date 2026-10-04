import type {
  BrandIdentifierSpec,
  ProductSpecs,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import {
  BrandIdentifiedListing,
  foldBrandIdentifierSpecs,
  foldReleaseYear,
} from './deterministic-specs';

describe('foldReleaseYear', () => {
  // A pipeline without `cast: number` hands over the text it captured.
  it.each([[2026], ['2026'], ["'26"], ['26']])(
    'folds the release year %p into modelYear as 2026',
    (releaseYear) => {
      const specs: ProductSpecs = { weight: 24 };
      foldReleaseYear(specs, releaseYear);
      expect(specs).toEqual({ weight: 24, modelYear: 2026 });
    },
  );

  it('never overrides a year the spec mapping found', () => {
    const specs: ProductSpecs = { modelYear: 2025 };
    foldReleaseYear(specs, 2026);
    expect(specs).toEqual({ modelYear: 2025 });
  });

  // The normaliser leaves an unreadable mapped year present but undefined.
  it('fills a year the spec mapping could not read', () => {
    const specs: ProductSpecs = { modelYear: undefined };
    foldReleaseYear(specs, '2026');
    expect(specs).toEqual({ modelYear: 2026 });
  });

  it.each([[undefined], ['2025/2026'], ['abc']])(
    'folds nothing in for %p',
    (releaseYear) => {
      const specs: ProductSpecs = { weight: 24 };
      foldReleaseYear(specs, releaseYear);
      expect(specs).toEqual({ weight: 24 });
    },
  );
});

describe('foldBrandIdentifierSpecs', () => {
  const schema = {
    title: 'ebikes',
    type: 'object',
    properties: {
      modelYear: { type: 'number', title: 'Model year', meta: { format: 'year' } },
      frameType: { type: 'string', title: 'Frame', enum: ['Magas', 'Alacsony'] },
    },
  } as SpecDefinitionJsonSchema;
  // KTM's two article-number forms, as the ebikes config states them.
  const rules: Record<string, BrandIdentifierSpec[]> = {
    KTM: [
      { spec: 'modelYear', identifier: 'mpn', pattern: '^1(2\\d)\\d{7}$', prefix: '20' },
      { spec: 'modelYear', identifier: 'mpn', pattern: '^0(2\\d)\\d{6}$', prefix: '20' },
    ],
  };
  const fold = (
    listing: BrandIdentifiedListing,
    specs: ProductSpecs = {},
    byBrand = rules,
  ) => {
    foldBrandIdentifierSpecs(specs, listing, byBrand, schema);
    return specs;
  };

  it.each([
    ['1260040108', 2026],
    ['025163108', 2025],
  ])("reads the year off KTM's article number %s", (mpn, year) => {
    expect(fold({ brand: 'KTM', offers: [{ mpn }] })).toEqual({ modelYear: year });
  });

  it('matches the brand however the shop cases it', () => {
    expect(fold({ brand: ' ktm ', offers: [{ mpn: '1260040108' }] })).toEqual({
      modelYear: 2026,
    });
  });

  // A Cube Cargo article number fits KTM's pattern.
  it("leaves another brand's listing untouched", () => {
    expect(fold({ brand: 'Cube', offers: [{ mpn: '1244000767' }] })).toEqual({});
  });

  it('never overrides a year the listing states', () => {
    expect(fold({ brand: 'KTM', offers: [{ mpn: '1260040108' }] }, { modelYear: 2025 })).toEqual(
      { modelYear: 2025 },
    );
  });

  it('fills a year the spec mapping could not read', () => {
    expect(
      fold({ brand: 'KTM', offers: [{ mpn: '1260040108' }] }, { modelYear: undefined }),
    ).toEqual({ modelYear: 2026 });
  });

  it('takes the first rule that matches, in the order the config lists them', () => {
    const twoRules = {
      KTM: [
        { spec: 'modelYear', identifier: 'mpn' as const, pattern: '^9(\\d\\d)$', prefix: '20' },
        { spec: 'modelYear', identifier: 'mpn' as const, pattern: '^(\\d\\d)9$', prefix: '20' },
      ],
    };
    expect(fold({ brand: 'KTM', offers: [{ mpn: '929' }] }, {}, twoRules)).toEqual({
      modelYear: 2029,
    });
  });

  it('reads the identifier the rule names and nothing else', () => {
    expect(fold({ brand: 'KTM', offers: [{ gtin: '1260040108', mpn: 'X1' }] })).toEqual({});
    const byGtin = {
      KTM: [{ spec: 'modelYear', identifier: 'gtin' as const, pattern: '^90(\\d\\d)\\d+$' }],
    };
    expect(fold({ brand: 'KTM', offers: [{ gtin: '902612345' }] }, {}, byGtin)).toEqual({
      modelYear: 2026,
    });
  });

  it('reads any of the offers, skipping the ones without an identifier', () => {
    expect(
      fold({ brand: 'KTM', offers: [{ mpn: null }, { mpn: 'size-M' }, { mpn: '1250040108' }] }),
    ).toEqual({ modelYear: 2025 });
  });

  it.each([
    ['an enum value, in the enum spelling', 'alacsony', { frameType: 'Alacsony' }],
    ['nothing for a value off the list', 'trapez', {}],
  ])('folds %s', (_case, captured, expected) => {
    const byFrame = {
      KTM: [{ spec: 'frameType', identifier: 'mpn' as const, pattern: '^F-(\\w+)$' }],
    };
    expect(fold({ brand: 'KTM', offers: [{ mpn: `F-${captured}` }] }, {}, byFrame)).toEqual(
      expected,
    );
  });
});
