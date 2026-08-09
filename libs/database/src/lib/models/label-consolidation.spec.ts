import { Sentiment } from '../postgres/types/sentiment';
import {
  consolidateSentiment,
  DEFAULT_QUALITY_WEIGHTS,
  qualityWeightOf,
  WeightedEntry,
} from './label-consolidation';

function entry(sentiment: Sentiment, qualityWeight = 1.0): WeightedEntry {
  return { sentiment, qualityWeight };
}

describe('qualityWeightOf', () => {
  it('returns 1.0 for high', () => {
    expect(qualityWeightOf('high')).toBe(1.0);
  });

  it('returns 0.6 for medium', () => {
    expect(qualityWeightOf('medium')).toBe(0.6);
  });

  it('returns 0.25 for low', () => {
    expect(qualityWeightOf('low')).toBe(0.25);
  });

  it('treats undefined as medium', () => {
    expect(qualityWeightOf(undefined)).toBe(0.6);
  });

  it('respects custom weights', () => {
    expect(qualityWeightOf('high', { high: 2.0, medium: 1.0, low: 0.5 })).toBe(2.0);
    expect(qualityWeightOf('low', { high: 2.0, medium: 1.0, low: 0.5 })).toBe(0.5);
  });
});

describe('consolidateSentiment', () => {
  describe('worked examples from §9.1', () => {
    it('1x high StrongPositive → StrongPositive', () => {
      expect(consolidateSentiment([entry(Sentiment.StrongPositive, 1.0)])).toBe(
        Sentiment.StrongPositive,
      );
    });

    it('1x low StrongPositive → Neutral (P = 0.375, below positiveThreshold)', () => {
      expect(consolidateSentiment([entry(Sentiment.StrongPositive, 0.25)])).toBe(
        Sentiment.Neutral,
      );
    });

    it('1x medium StrongPositive → Positive (P = 0.9, net < strongThreshold)', () => {
      expect(consolidateSentiment([entry(Sentiment.StrongPositive, 0.6)])).toBe(
        Sentiment.Positive,
      );
    });

    it('2x high Positive → Positive (S = 0, cannot promote to StrongPositive)', () => {
      expect(
        consolidateSentiment([entry(Sentiment.Positive, 1.0), entry(Sentiment.Positive, 1.0)]),
      ).toBe(Sentiment.Positive);
    });

    it('1x high StrongPositive + 1x low Negative → Positive', () => {
      expect(
        consolidateSentiment([
          entry(Sentiment.StrongPositive, 1.0),
          entry(Sentiment.Negative, 0.25),
        ]),
      ).toBe(Sentiment.Positive);
    });

    it('1x high StrongPositive + 1x high StrongNegative → Mixed', () => {
      expect(
        consolidateSentiment([
          entry(Sentiment.StrongPositive, 1.0),
          entry(Sentiment.StrongNegative, 1.0),
        ]),
      ).toBe(Sentiment.Mixed);
    });

    it('1x high StrongPositive + 1x medium StrongNegative → Positive (T below minStrongMixed)', () => {
      expect(
        consolidateSentiment([
          entry(Sentiment.StrongPositive, 1.0),
          entry(Sentiment.StrongNegative, 0.6),
        ]),
      ).toBe(Sentiment.Positive);
    });

    it('1x medium Positive + 1x medium Negative → Mixed (P > 0 and N > 0, net within band)', () => {
      expect(
        consolidateSentiment([entry(Sentiment.Positive, 0.6), entry(Sentiment.Negative, 0.6)]),
      ).toBe(Sentiment.Mixed);
    });

    it('1x high Mixed only → Mixed', () => {
      expect(consolidateSentiment([entry(Sentiment.Mixed, 1.0)])).toBe(Sentiment.Mixed);
    });

    it('only Neutral entries → Neutral', () => {
      expect(
        consolidateSentiment([entry(Sentiment.Neutral, 1.0), entry(Sentiment.Neutral, 1.0)]),
      ).toBe(Sentiment.Neutral);
    });

    it('ref-level Positive on dual use → Positive', () => {
      expect(consolidateSentiment([entry(Sentiment.Positive, 1.0)])).toBe(Sentiment.Positive);
    });
  });

  describe('boundary cases', () => {
    it('empty entry list → Neutral', () => {
      expect(consolidateSentiment([])).toBe(Sentiment.Neutral);
    });

    it('Mixed alone never promotes to StrongPositive even at high quality', () => {
      expect(consolidateSentiment([entry(Sentiment.Mixed, 10.0)])).toBe(Sentiment.Mixed);
    });

    it('two medium Strongs on each side → Mixed (S = 1.2, T = 1.2, both >= minStrongMixed=1.0)', () => {
      expect(
        consolidateSentiment([
          entry(Sentiment.StrongPositive, 0.6),
          entry(Sentiment.StrongPositive, 0.6),
          entry(Sentiment.StrongNegative, 0.6),
          entry(Sentiment.StrongNegative, 0.6),
        ]),
      ).toBe(Sentiment.Mixed);
    });

    it('pile of moderate positives never promotes to StrongPositive without a Strong entry', () => {
      const entries = Array(10).fill(0).map(() => entry(Sentiment.Positive, 1.0));
      expect(consolidateSentiment(entries)).toBe(Sentiment.Positive);
    });

    it('single Negative low-quality below positiveThreshold → Neutral', () => {
      expect(consolidateSentiment([entry(Sentiment.Negative, 0.25)])).toBe(Sentiment.Neutral);
    });

    it('respects injected thresholds', () => {
      // Lower strongThreshold to 0.8 so 1x medium StrongPositive (P=0.9) hits StrongPositive.
      expect(
        consolidateSentiment([entry(Sentiment.StrongPositive, 0.6)], {
          strongThreshold: 0.8,
          positiveThreshold: 0.3,
          minStrongMixed: 1.0,
        }),
      ).toBe(Sentiment.StrongPositive);
    });
  });

  it('uses the documented default quality weights', () => {
    // Sanity check: defaults exposed for callers that want to mirror them.
    expect(DEFAULT_QUALITY_WEIGHTS).toEqual({ high: 1.0, medium: 0.6, low: 0.25 });
  });
});
