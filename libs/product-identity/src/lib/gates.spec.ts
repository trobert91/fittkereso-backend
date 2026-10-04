import type {
  ProductCategoryConfig,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { applyGates, primarySpecMismatches, scoreOf } from './gates';
import { baseScore, nameSimilarity } from './name-similarity';
import { ACCEPT_SCORE, NEAR_MISS_SCORE } from './product-identity.constants';

const ebikes: ProductCategoryConfig = {
  primarySpecs: ['modelYear', 'batteryCapacity', 'usageType'],
  matcherSpecs: ['motorPower', 'weight', 'frameMaterial', 'usageType'],
  matchingConfig: {
    compatibleValues: {
      usageType: { MTB: ['Összteleszkópos MTB'], Trekking: ['Cross Trekking'] },
    },
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
    queryModel: KEY,
    candidateModel: KEY,
    querySpecs,
    candidateSpecs,
    categoryConfig: ebikes,
  });
}

/** Score of a candidate whose name key is identical to the query's. */
function identicalNameScore(querySpecs: ProductSpecs, candidateSpecs: ProductSpecs) {
  return scoreOf(
    baseScore(nameSimilarity(KEY, KEY)),
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
    expect(applyGates({ queryModel: KEY, candidateModel: KEY, categoryConfig: ebikes })).toEqual([]);
  });

  it('uses the category tolerances and compatible values', () => {
    // batteryCapacity is exact; weight keeps the 5% default; usageType lists compatible values.
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

  it('fails a matcher spec at severity 10', () => {
    expect(specGates({ motorPower: 250 }, { motorPower: 500 })).toEqual([
      expect.objectContaining({ gate: 'matcherSpecMismatch', spec: 'motorPower', severity: 10 }),
    ]);
  });

  it('has no spec gates for a category without spec lists', () => {
    expect(
      applyGates({
        queryModel: KEY,
        candidateModel: KEY,
        querySpecs: { modelYear: 2023 },
        candidateSpecs: { modelYear: 2024 },
        categoryConfig: {},
      }),
    ).toEqual([]);
  });

  describe('model numbers', () => {
    it("fails when neither key's numbers contain the other's", () => {
      expect(applyGates({ queryModel: '720 cross macina', candidateModel: '725 cross macina' })).toEqual([
        {
          gate: 'modelNumberMismatch',
          severity: 30,
          queryValue: ['720'],
          candidateValue: ['725'],
        },
      ]);
    });

    it("passes when one key's numbers are a subset of the other's", () => {
      expect(applyGates({ queryModel: '2024 720 cross macina', candidateModel: '720 cross macina' })).toEqual([]);
    });

    it('skips when either key has no number', () => {
      expect(applyGates({ queryModel: 'cross macina', candidateModel: '725 cross macina' })).toEqual([]);
    });

    // #9 issue 5: bikelife writes "CX830", the other shops "CX 830".
    it('reads a model number written apart as the same number', () => {
      expect(
        applyGates({ queryModel: 'Macina Tour CX830', candidateModel: 'Macina Tour CX 830' }),
      ).toEqual([]);
      expect(
        applyGates({ queryModel: 'Macina Tour CX 830', candidateModel: 'Macina Tour CX830' }),
      ).toEqual([]);
    });

    // KTM's A510, P510 and CX510 differ only in their glued letters.
    it.each([
      ['Macina Central A510', 'Macina Central P510'],
      ['Macina Tour CX510', 'Macina Tour P510'],
    ])('tells %s from %s by the letters glued to the number', (queryModel, candidateModel) => {
      expect(applyGates({ queryModel, candidateModel })).toEqual([
        expect.objectContaining({ gate: 'modelNumberMismatch' }),
      ]);
    });

    it('passes one name printing more of the model, as written', () => {
      expect(
        applyGates({ queryModel: 'Macina Style 810 Di2', candidateModel: 'Macina Style 810' }),
      ).toEqual([]);
    });
  });
});

describe('missing specs', () => {
  const withYearPenalty: ProductCategoryConfig = {
    ...ebikes,
    matchingConfig: {
      ...ebikes.matchingConfig,
      missingSpecPenalty: { modelYear: 25 },
    },
  };
  const gatesFor = (
    querySpecs: ProductSpecs | undefined,
    candidateSpecs: ProductSpecs | undefined,
    categoryConfig = withYearPenalty,
  ) =>
    applyGates({ queryModel: KEY, candidateModel: KEY, querySpecs, candidateSpecs, categoryConfig });

  it('charges the configured points when only one side states the spec, with null on the silent side', () => {
    expect(gatesFor({ batteryCapacity: 625 }, { modelYear: 2025 })).toEqual([
      { gate: 'specMissing', spec: 'modelYear', severity: 25, queryValue: null, candidateValue: 2025 },
    ]);
    expect(gatesFor({ modelYear: 2026 }, undefined)).toEqual([
      { gate: 'specMissing', spec: 'modelYear', severity: 25, queryValue: 2026, candidateValue: null },
    ]);
  });

  it('keeps identical names out of auto-attach, in review', () => {
    const score = scoreOf(
      baseScore(nameSimilarity(KEY, KEY)),
      gatesFor({ batteryCapacity: 625 }, { modelYear: 2025 }),
    );

    expect(score).toBe(75);
    expect(score).toBeLessThan(ACCEPT_SCORE);
    expect(score).toBeGreaterThanOrEqual(NEAR_MISS_SCORE);
  });

  it('costs nothing when neither side states it, so two silent listings of one bike still match', () => {
    expect(gatesFor({ batteryCapacity: 625 }, { batteryCapacity: 625 })).toEqual([]);
  });

  it('leaves a stated value on both sides to the mismatch gate', () => {
    expect(gatesFor({ modelYear: 2026 }, { modelYear: 2026 })).toEqual([]);
    expect(gatesFor({ modelYear: 2026 }, { modelYear: 2025 })).toEqual([
      expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'modelYear' }),
    ]);
  });

  it('reads an empty string or a zero as missing, like the mismatch gates', () => {
    expect(gatesFor({ modelYear: 0 }, { modelYear: 2025 })).toEqual([
      expect.objectContaining({ gate: 'specMissing', queryValue: null }),
    ]);
  });

  it('charges nothing for a spec the category does not name', () => {
    expect(gatesFor({}, { modelYear: 2025 }, ebikes)).toEqual([]);
  });
});

describe('per-spec mismatch penalties', () => {
  const withPenalties = (
    specMismatchPenalty: Record<string, number>,
  ): ProductCategoryConfig => ({
    ...ebikes,
    matchingConfig: { ...ebikes.matchingConfig, specMismatchPenalty },
  });
  const gatesFor = (
    querySpecs: ProductSpecs,
    candidateSpecs: ProductSpecs,
    categoryConfig: ProductCategoryConfig,
  ) =>
    applyGates({ queryModel: KEY, candidateModel: KEY, querySpecs, candidateSpecs, categoryConfig });

  it('charges a primary spec its own points', () => {
    expect(
      gatesFor({ modelYear: 2026 }, { modelYear: 2025 }, withPenalties({ modelYear: 50 })),
    ).toEqual([
      {
        gate: 'primarySpecMismatch',
        spec: 'modelYear',
        severity: 50,
        queryValue: 2026,
        candidateValue: 2025,
      },
    ]);
  });

  // The point of the override: a year apart is two products, so identical
  // names don't even reach review.
  it('takes identical names a year apart below NEAR_MISS_SCORE', () => {
    const score = scoreOf(
      baseScore(nameSimilarity(KEY, KEY)),
      gatesFor({ modelYear: 2026 }, { modelYear: 2025 }, withPenalties({ modelYear: 50 })),
    );

    expect(score).toBe(50);
    expect(score).toBeLessThan(NEAR_MISS_SCORE);
  });

  it('charges a matcher spec its own points', () => {
    expect(
      gatesFor({ motorPower: 250 }, { motorPower: 600 }, withPenalties({ motorPower: 25 })),
    ).toEqual([
      expect.objectContaining({ gate: 'matcherSpecMismatch', spec: 'motorPower', severity: 25 }),
    ]);
  });

  it('keeps the default for every spec it does not name', () => {
    expect(
      gatesFor(
        { modelYear: 2026, batteryCapacity: 750, motorPower: 250 },
        { modelYear: 2025, batteryCapacity: 800, motorPower: 600 },
        withPenalties({ modelYear: 50 }),
      ).map(({ spec, severity }) => [spec, severity]),
    ).toEqual([
      ['modelYear', 50],
      ['batteryCapacity', 30],
      ['motorPower', 10],
    ]);
  });

  it('still needs a value on both sides', () => {
    expect(gatesFor({}, { modelYear: 2025 }, withPenalties({ modelYear: 50 }))).toEqual([]);
  });

  it('turns the gate off at 0', () => {
    const off = withPenalties({ modelYear: 0 });

    expect(gatesFor({ modelYear: 2026 }, { modelYear: 2025 }, off)).toEqual([]);
    expect(
      primarySpecMismatches({
        querySpecs: { modelYear: 2026 },
        candidateSpecs: { modelYear: 2025 },
        categoryConfig: off,
      }),
    ).toEqual([]);
  });

  it('adds no gate for a spec in neither list', () => {
    expect(
      gatesFor({ gearCount: 11 }, { gearCount: 12 }, withPenalties({ gearCount: 50 })),
    ).toEqual([]);
  });

  // An identifier's pair still scores 100 and goes to review; the reviewer
  // sees the spec's own points.
  it('reports the same points on a product an identifier found', () => {
    expect(
      primarySpecMismatches({
        querySpecs: { modelYear: 2026 },
        candidateSpecs: { modelYear: 2025 },
        categoryConfig: withPenalties({ modelYear: 50 }),
      }),
    ).toEqual([
      expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'modelYear', severity: 50 }),
    ]);
  });
});

// For a candidate an identifier found: the names are not in question, and a
// size in one shop's title ("l/48") must not read as another model number.
describe('primarySpecMismatches', () => {
  it('never charges a missing spec: an identifier already vouched for the match', () => {
    expect(
      primarySpecMismatches({
        querySpecs: {},
        candidateSpecs: { modelYear: 2025 },
        categoryConfig: {
          ...ebikes,
          matchingConfig: { missingSpecPenalty: { modelYear: 25 } },
        },
      }),
    ).toEqual([]);
  });

  it('reports only primary-spec contradictions', () => {
    expect(
      primarySpecMismatches({
        querySpecs: { modelYear: 2027, motorPower: 250 },
        candidateSpecs: { modelYear: 2025, motorPower: 600 },
        categoryConfig: ebikes,
      }),
    ).toEqual([
      expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'modelYear' }),
    ]);
  });

  it('finds nothing when the primary specs agree or are missing', () => {
    expect(
      primarySpecMismatches({
        querySpecs: { modelYear: 2026 },
        candidateSpecs: { modelYear: 2026, batteryCapacity: 800 },
        categoryConfig: ebikes,
      }),
    ).toEqual([]);
  });
});

describe('scoreOf', () => {
  it("subtracts every failed gate's severity", () => {
    expect(identicalNameScore({ modelYear: 2023, motorPower: 250 }, { modelYear: 2024, motorPower: 500 })).toBe(60);
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
      70,
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

  // The model numbers differ, so the gate fires; a subset passes.
  it.each([
    ['720 cross macina', '725 cross macina', 38],
    ['2024 720 cross macina', '720 cross macina', 79],
  ])('scores "%s" against "%s" at %i', (queryKey, candidateKey, expected) => {
    const base = baseScore(nameSimilarity(queryKey, candidateKey));

    expect(scoreOf(base, applyGates({ queryModel: queryKey, candidateModel: candidateKey }))).toBe(expected);
  });
});
