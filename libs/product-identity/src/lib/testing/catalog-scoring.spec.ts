import { baseScore, nameSimilarity } from '../name-similarity';
import { ACCEPT_SCORE, NEAR_MISS_SCORE } from '../product-identity.constants';
import {
  CATALOG_IDF,
  CATALOG,
  allScoredPairs,
  candidateOf,
  oneByKey,
  pairByKey,
  scoreBetween,
  trigramBetween,
} from './catalog';

describe('scoring the real KTM catalog', () => {
  it('has the catalog the other specs rely on', () => {
    expect(CATALOG).toHaveLength(58);
    expect(CATALOG.every((product) => product.brand === 'KTM')).toBe(true);
    expect(CATALOG.every((product) => product.categorySlug === 'ebikes')).toBe(true);
    expect(CATALOG.every((product) => product.nameKey.length > 0)).toBe(true);
  });

  it('keeps every score a whole number inside 1–100', () => {
    for (const { score } of allScoredPairs()) {
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(score)).toBe(true);
    }
  });

  it('scores symmetrically — which product asks does not change the answer', () => {
    for (const { query, candidate } of allScoredPairs()) {
      expect(scoreBetween(query, candidate)).toBe(scoreBetween(candidate, query));
    }
  });

  describe('the same bike reaching the catalog twice', () => {
    // Identical name key and every gate-relevant spec agreeing: the strongest
    // evidence there is, and the only shape that may auto-attach outright.
    it.each([['di2 macina master scarp sx'], ['771 di2 glorious lycan macina']])(
      'scores %s at a perfect 100',
      (nameKey) => {
        const [a, b] = pairByKey(nameKey);

        expect(trigramBetween(a, b)).toBe(1);
        expect(candidateOf(a, b).failedGates).toEqual([]);
        expect(scoreBetween(a, b)).toBe(100);
      },
    );

    it('caps a pair at 70 when only the frame shape separates it', () => {
      // Two Prime0 products with the same name key, the same year and the same
      // battery, but one is a Trapéz frame and the other an Alacsony. Since
      // 2026-09-16 frameType is a primary spec, so this is a 30-point gate:
      // reviewable, never auto-attached.
      const [a, b] = pairByKey('macina prime0 sport sx t-type');

      expect(candidateOf(a, b).failedGates).toEqual([
        expect.objectContaining({
          gate: 'primarySpecMismatch',
          spec: 'frameType',
          severity: 30,
        }),
      ]);
      expect(scoreBetween(a, b)).toBe(NEAR_MISS_SCORE);
      expect(scoreBetween(a, b)).toBeLessThan(ACCEPT_SCORE);
    });
  });

  describe('the same name, different bike', () => {
    // One primary spec costs 30, landing an otherwise identical pair exactly on
    // NEAR_MISS_SCORE: reachable by the LLM and by a person, never auto-attached.
    it.each([
      ['chacana lfc macina'],
      ['elite macina prowler'],
      ['810 di2 macina style'],
    ])('caps %s at exactly 70 for a model year apart', (nameKey) => {
      const [a, b] = pairByKey(nameKey);

      expect(scoreBetween(a, b)).toBe(NEAR_MISS_SCORE);
      expect(scoreBetween(a, b)).toBeLessThan(ACCEPT_SCORE);
      expect(candidateOf(a, b).failedGates).toEqual([
        expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'modelYear' }),
      ]);
    });

    it('stacks a matcher spec on top of the model year', () => {
      // 2025 vs 2026 and a 10-speed against a 12-speed: 100 − 30 − 10.
      const [a, b] = pairByKey('892 abs lfc macina team');

      expect(candidateOf(a, b).failedGates.map((gate) => gate.spec).sort()).toEqual([
        'gearCount',
        'modelYear',
      ]);
      expect(scoreBetween(a, b)).toBe(60);
      expect(scoreBetween(a, b)).toBeLessThan(NEAR_MISS_SCORE);
    });

    it('drops to 40 when two primary specs disagree', () => {
      // The same city bike a year apart, and the shops disagree on whether it
      // is a City or a Trekking bike: 100 − 30 − 30.
      const [a, b] = pairByKey('810 belt city macina');

      expect(scoreBetween(a, b)).toBe(40);
      expect(candidateOf(a, b).failedGates.map((gate) => gate.spec).sort()).toEqual([
        'modelYear',
        'usageType',
      ]);
    });
  });

  describe('name similarity', () => {
    it('blends all three, and the character measures alone would overrate this pair', () => {
      // "771 …" against "772 …" differs by one character in twenty-nine, which
      // Levenshtein reads far more generously than trigram does — and which
      // both read far more generously than the alignment does, since a model
      // number is never absorbed as a typo. The blend is what keeps two
      // different bikes off ACCEPT_SCORE on the strength of one digit.
      const a = oneByKey('771 di2 glorious lycan macina');
      const b = oneByKey('772 di2 glorious lycan macina');
      const similarity = nameSimilarity(a.nameKey, b.nameKey, CATALOG_IDF);

      expect(similarity.trigram).toBeCloseTo(trigramBetween(a, b), 6);
      expect(similarity.levenshtein).toBeGreaterThan(similarity.trigram);
      expect(similarity.alignment).toBeLessThan(similarity.trigram);
      expect(baseScore(similarity)).toBeLessThan(
        Math.round(100 * similarity.levenshtein),
      );
    });

    it('scores a product against itself at 100 on all three measures', () => {
      const product = CATALOG[0];
      const similarity = nameSimilarity(product.nameKey, product.nameKey, CATALOG_IDF);

      expect(similarity).toEqual({ trigram: 1, levenshtein: 1, alignment: 1 });
      expect(baseScore(similarity)).toBe(100);
    });
  });

  describe('the shape of the catalog as a whole', () => {
    it('recalls widely and scores narrowly', () => {
      const pairs = allScoredPairs();

      expect(pairs).toHaveLength(334);
      // Was 9 before frameType became a primary spec on 2026-09-16.
      expect(pairs.filter((pair) => pair.score >= ACCEPT_SCORE)).toHaveLength(5);
      // Was 10 before baseScore became a blend: the review band is where a
      // name difference the character measures could not classify used to
      // land, and six of those ten resolved to one side of it or the other.
      expect(
        pairs.filter(
          (pair) => pair.score >= NEAR_MISS_SCORE && pair.score < ACCEPT_SCORE,
        ),
      ).toHaveLength(4);
    });

    /**
     * One pair clears ACCEPT_SCORE without sharing a name key. It was four
     * until 2026-09-16, when the ebikes schema learned the frame shapes the
     * shops actually publish (Magas / Trapéz) and frameType became a primary
     * spec — that separated the three frame-shape pairs outright.
     *
     * What survives is a frame *size* token: "8973 kapoho l macina" is the L
     * of "8973 kapoho macina", which the reviewer confirmed is one bike in two
     * sizes. So this remaining entry is a correct merge, not a defect — but it
     * is pinned all the same, because nothing in the score distinguishes a
     * size token from a shape token.
     */
    it('pins the different-key pairs that would auto-attach today', () => {
      const risky = allScoredPairs()
        .filter(
          (pair) =>
            pair.score >= ACCEPT_SCORE &&
            pair.query.nameKey !== pair.candidate.nameKey,
        )
        .map((pair) => [pair.query.nameKey, pair.candidate.nameKey, pair.score])
        .sort();

      expect(risky).toEqual([['8973 kapoho l macina', '8973 kapoho macina', 84]]);
    });
  });
});
