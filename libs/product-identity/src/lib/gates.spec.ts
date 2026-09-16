import type {
  ProductCategoryConfig,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { applyGates, scoreOf } from './gates';
import { baseScore, nameSimilarity } from './name-similarity';
import { ACCEPT_SCORE, NEAR_MISS_SCORE } from './product-identity.constants';

const ebikes: ProductCategoryConfig = {
  primarySpecs: ['modelYear', 'batteryCapacity', 'usageType'],
  matcherSpecs: ['motorPower', 'weight', 'frameMaterial', 'usageType'],
  matcherSpecHierarchies: {
    usageType: { MTB: ['Összteleszkópos MTB'], Trekking: ['Cross Trekking'] },
  },
  matchingConfig: {
    specTolerances: {
      modelYear: { absolute: 0 },
      batteryCapacity: { absolute: 0 },
      motorPower: { absolute: 0 },
    },
  },
};

const KEY = '140 hybrid stereo';

function specGates(querySpecs: ProductSpecs, candidateSpecs: ProductSpecs) {
  return applyGates({
    queryKey: KEY,
    candidateKey: KEY,
    querySpecs,
    candidateSpecs,
    categoryConfig: ebikes,
  });
}

/** Score of a candidate whose name key is identical to the query's. */
function identicalNameScore(querySpecs: ProductSpecs, candidateSpecs: ProductSpecs) {
  return scoreOf(
    baseScore(nameSimilarity(1, KEY, KEY)),
    specGates(querySpecs, candidateSpecs),
  );
}

describe('applyGates', () => {
  it('finds nothing when names and specs agree', () => {
    expect(specGates({ modelYear: 2024, weight: 22 }, { modelYear: 2024, weight: 22 })).toEqual([]);
  });

  it('fails a primary spec with both values', () => {
    expect(specGates({ modelYear: 2023 }, { modelYear: 2024 })).toEqual([
      {
        gate: 'primarySpecMismatch',
        spec: 'modelYear',
        severity: 30,
        queryValue: 2023,
        candidateValue: 2024,
      },
    ]);
  });

  it('skips a spec missing on either side', () => {
    expect(specGates({ modelYear: 2023 }, { batteryCapacity: 750 })).toEqual([]);
    expect(specGates({}, { modelYear: 2024 })).toEqual([]);
    expect(applyGates({ queryKey: KEY, candidateKey: KEY, categoryConfig: ebikes })).toEqual([]);
  });

  it('uses the category tolerances and hierarchies', () => {
    // batteryCapacity is exact; weight keeps the 5% default; usageType has a hierarchy.
    expect(specGates({ batteryCapacity: 750 }, { batteryCapacity: 760 })).toHaveLength(1);
    expect(specGates({ weight: 22 }, { weight: 22.5 })).toEqual([]);
    expect(specGates({ usageType: 'Összteleszkópos MTB' }, { usageType: 'MTB' })).toEqual([]);
  });

  it('compares only the configured specs', () => {
    expect(specGates({ color: 'red' }, { color: 'blue' })).toEqual([]);
  });

  it('counts a key in both lists as primary', () => {
    expect(specGates({ usageType: 'MTB' }, { usageType: 'Trekking' })).toEqual([
      expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'usageType', severity: 30 }),
    ]);
  });

  it('fails a matcher spec at severity 5', () => {
    expect(specGates({ motorPower: 250 }, { motorPower: 500 })).toEqual([
      expect.objectContaining({ gate: 'matcherSpecMismatch', spec: 'motorPower', severity: 5 }),
    ]);
  });

  it('has no spec gates for a category without spec lists', () => {
    expect(
      applyGates({
        queryKey: KEY,
        candidateKey: KEY,
        querySpecs: { modelYear: 2023 },
        candidateSpecs: { modelYear: 2024 },
        categoryConfig: {},
      }),
    ).toEqual([]);
  });

  describe('model numbers', () => {
    it("fails when neither key's numbers contain the other's", () => {
      expect(applyGates({ queryKey: '720 cross macina', candidateKey: '725 cross macina' })).toEqual([
        {
          gate: 'modelNumberMismatch',
          severity: 30,
          queryValue: ['720'],
          candidateValue: ['725'],
        },
      ]);
    });

    it("passes when one key's numbers are a subset of the other's", () => {
      expect(applyGates({ queryKey: '2024 720 cross macina', candidateKey: '720 cross macina' })).toEqual([]);
    });

    it('skips when either key has no number', () => {
      expect(applyGates({ queryKey: 'cross macina', candidateKey: '725 cross macina' })).toEqual([]);
    });
  });
});

describe('scoreOf', () => {
  it("subtracts every failed gate's severity", () => {
    expect(identicalNameScore({ modelYear: 2023, motorPower: 250 }, { modelYear: 2024, motorPower: 500 })).toBe(65);
  });

  it('stays within 1–100', () => {
    expect(scoreOf(40, specGates({ modelYear: 2023, batteryCapacity: 500 }, { modelYear: 2024, batteryCapacity: 750 }))).toBe(1);
    expect(scoreOf(100, [])).toBe(100);
  });

  // Pinned so recalibration can't break it: one primary mismatch never auto-attaches.
  it('caps identical names with one primary mismatch at exactly NEAR_MISS_SCORE', () => {
    const score = identicalNameScore({ modelYear: 2023 }, { modelYear: 2024 });

    expect(score).toBe(70);
    expect(score).toBe(NEAR_MISS_SCORE);
    expect(score).toBeLessThan(ACCEPT_SCORE);
  });

  it.each<[string, ProductSpecs, ProductSpecs, number]>([
    ['identical', {}, {}, 100],
    [
      'identical, 3 matcher mismatches',
      { motorPower: 250, weight: 22, frameMaterial: 'Aluminium' },
      { motorPower: 500, weight: 30, frameMaterial: 'Carbon' },
      85,
    ],
    ['identical, modelYear differs', { modelYear: 2023 }, { modelYear: 2024 }, 70],
    [
      'identical, modelYear and batteryCapacity differ',
      { modelYear: 2023, batteryCapacity: 625 },
      { modelYear: 2024, batteryCapacity: 750 },
      40,
    ],
  ])('scores %s at %i', (_label, querySpecs, candidateSpecs, expected) => {
    expect(identicalNameScore(querySpecs, candidateSpecs)).toBe(expected);
  });

  it.each([
    ['720 cross macina', '725 cross macina', 64],
    ['2024 720 cross macina', '720 cross macina', 76],
  ])('scores "%s" against "%s" at %i', (queryKey, candidateKey, expected) => {
    const base = baseScore(nameSimilarity(0, queryKey, candidateKey));

    expect(scoreOf(base, applyGates({ queryKey, candidateKey }))).toBe(expected);
  });
});
