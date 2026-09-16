import {
  baseScore,
  levenshtein,
  levenshteinSimilarity,
  nameSimilarity,
} from './name-similarity';

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

describe('baseScore', () => {
  it('takes the better of trigram and Levenshtein, as 0–100', () => {
    expect(baseScore({ trigram: 0.9, levenshtein: 0.5 })).toBe(90);
    expect(baseScore({ trigram: 0.3, levenshtein: 0.764 })).toBe(76);
  });

  it.each([
    ['720 cross macina', '720 cross macina', 100],
    ['720 cross macina', '725 cross macina', 94],
    ['2024 720 cross macina', '720 cross macina', 76],
  ])('scores "%s" against "%s" at %i on Levenshtein alone', (queryKey, candidateKey, expected) => {
    expect(baseScore(nameSimilarity(0, queryKey, candidateKey))).toBe(expected);
  });
});
