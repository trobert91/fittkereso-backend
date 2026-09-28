import type { ProductSpecs } from '@fittkereso-backend/database';
import { foldReleaseYear } from './deterministic-specs';

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
