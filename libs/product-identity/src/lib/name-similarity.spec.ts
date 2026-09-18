import {
  FLAT_IDF,
  alignTokens,
  alignmentSimilarity,
  baseScore,
  levenshtein,
  levenshteinSimilarity,
  nameSimilarity,
  trigramSimilarity,
} from './name-similarity';
import { ALIGNMENT_WEIGHT } from './product-identity.constants';
import catalog from './testing/catalog.json';

describe('levenshtein', () => {
  it('counts insertions, deletions and substitutions', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('macina', 'macina')).toBe(0);
  });

  it('counts an accented letter as one edit', () => {
    expect(levenshtein('kő', 'ko')).toBe(1);
  });

  it('counts a character outside the BMP as one edit, not two code units', () => {
    expect(levenshtein('a🚲', 'ab')).toBe(1);
  });
});

describe('levenshteinSimilarity', () => {
  it('is 1 − edits / the longer key length', () => {
    expect(levenshteinSimilarity('720 cross macina', '725 cross macina')).toBeCloseTo(15 / 16);
  });

  it('treats two empty keys as identical', () => {
    expect(levenshteinSimilarity('', '')).toBe(1);
  });
});

describe('alignTokens', () => {
  it('pairs off every token both keys share', () => {
    expect(alignTokens('720 cross macina', '720 cross macina')).toEqual({
      onlyQuery: [],
      onlyCandidate: [],
    });
  });

  it('leaves an omitted token on one side only', () => {
    expect(alignTokens('771 di2 glorious lycan macina', '771 di2 lycan macina')).toEqual({
      onlyQuery: ['glorious'],
      onlyCandidate: [],
    });
  });

  it('leaves a substituted token on both sides', () => {
    expect(alignTokens('kapoho macina master', 'kapoho macina prestige')).toEqual({
      onlyQuery: ['master'],
      onlyCandidate: ['prestige'],
    });
  });

  it('absorbs a typo in a long word', () => {
    expect(alignTokens('macina prestige', 'macina prestigo').onlyQuery).toEqual([]);
  });

  it('never absorbs a model number, where one digit is a different bike', () => {
    expect(alignTokens('720 cross macina', '725 cross macina')).toEqual({
      onlyQuery: ['720'],
      onlyCandidate: ['725'],
    });
  });
});

describe('alignmentSimilarity', () => {
  it('is 1 for identical keys', () => {
    expect(alignmentSimilarity('720 cross macina', '720 cross macina')).toBe(1);
  });

  it('costs a substitution more than an omission', () => {
    const omission = alignmentSimilarity('771 di2 glorious lycan macina', '771 di2 lycan macina');
    const substitution = alignmentSimilarity('kapoho macina master', 'kapoho macina prestige');

    expect(omission).toBeCloseTo(0.8);
    expect(substitution).toBeCloseTo(0.55);
    expect(omission).toBeGreaterThan(substitution);
  });

  it('is blind to how long the rest of the name is', () => {
    expect(alignmentSimilarity('kapoho macina master', 'kapoho macina prestige')).toBeCloseTo(
      alignmentSimilarity('di2 macina master scarp sx', 'di2 macina prestige scarp sx'),
    );
  });

  it('charges nothing for a token every product of the brand carries', () => {
    const shared: Parameters<typeof alignmentSimilarity>[2] = (token) =>
      token === 'macina' ? 0 : 1;

    expect(alignmentSimilarity('cross macina', 'cross', shared)).toBe(1);
    expect(alignmentSimilarity('cross macina', 'cross', FLAT_IDF)).toBeCloseTo(0.8);
  });
});

describe('baseScore', () => {
  it('blends the three, with alignment weighted heaviest', () => {
    expect(baseScore({ trigram: 1, levenshtein: 1, alignment: 1 })).toBe(100);
    expect(baseScore({ trigram: 0, levenshtein: 0, alignment: 0 })).toBe(0);
    expect(baseScore({ trigram: 0.5, levenshtein: 0.5, alignment: 1 })).toBe(
      Math.round((100 * (1 + ALIGNMENT_WEIGHT)) / (2 + ALIGNMENT_WEIGHT)),
    );
  });

  it('falls back to the old rule for a stored row with no alignment', () => {
    expect(baseScore({ trigram: 0.9, levenshtein: 0.5 })).toBe(90);
  });

  it.each([
    ['720 cross macina', '720 cross macina', 100],
    ['720 cross macina', '725 cross macina', 68],
    ['2024 720 cross macina', '720 cross macina', 79],
  ])('scores "%s" against "%s" at %i', (queryKey, candidateKey, expected) => {
    expect(baseScore(nameSimilarity(queryKey, candidateKey))).toBe(expected);
  });

  // The pair the whole blend exists for: one shop leaves a colourway in the
  // model name (an omission, still the same bike) and two trim levels differ
  // (a substitution, two bikes). max(trigram, Levenshtein) scored these 70 and
  // 79 — the wrong way round, and both inside the review band.
  it('separates a colourway omission from a trim substitution', () => {
    const colourway = baseScore(
      nameSimilarity('771 di2 glorious lycan macina', '771 di2 lycan macina'),
    );
    const trim = baseScore(
      nameSimilarity('di2 macina master scarp sx', 'di2 macina prestige scarp sx'),
    );

    expect(colourway).toBeGreaterThan(trim);
  });
});

describe('trigramSimilarity', () => {
  // The scorer computes the trigram itself now, so it has to be pg_trgm's own
  // number and not an approximation of it. catalog.json holds Postgres'
  // `similarity()` for every key pair in the fixture that scores above zero.
  it("reproduces Postgres' similarity() on every pair in the catalog", () => {
    const pairs = catalog.trigrams as [string, string, number][];
    expect(pairs.length).toBeGreaterThan(1000);

    const wrong = pairs.filter(
      ([a, b, expected]) => Math.abs(trigramSimilarity(a, b) - expected) > 1e-6,
    );

    expect(wrong).toEqual([]);
  });

  it('is 1 for identical keys and 0 when nothing is shared', () => {
    expect(trigramSimilarity('720 cross macina', '720 cross macina')).toBe(1);
    expect(trigramSimilarity('abc', '')).toBe(0);
  });
});
