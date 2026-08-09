import { Sentiment } from '../postgres/types/sentiment';
import type { ContentQuality } from './product-resolution-context';

/**
 * Weighted sentiment consolidation for ReviewLabel.
 *
 * Replaces the old severity-first rule ("any strongPositive → StrongPositive").
 * Inputs are weighted by sentiment intensity AND quote quality, so a single
 * low-quality bare-verdict StrongPositive cannot outvote multiple high-quality
 * Positive observations. Ref-level entries (no enclosing quote, no quality
 * tier) are weighted as high-quality by default — they are confirmed
 * cross-quote signals from the LLM.
 *
 * The consolidator is intentionally a pure function with injected thresholds
 * so unit tests can override without going through DynamicConfigService.
 */

export interface WeightedEntry {
  sentiment: Sentiment;
  qualityWeight: number;
}

export interface LabelConsolidationThresholds {
  /** Net |P-N| required to commit to StrongPositive/StrongNegative. Default 1.5. */
  strongThreshold: number;
  /** Net |P-N| required to commit to Positive/Negative. Default 0.5. */
  positiveThreshold: number;
  /** Minimum pool size on EACH side (S, T) to lock in Mixed. Default 1.0. */
  minStrongMixed: number;
}

export const DEFAULT_LABEL_CONSOLIDATION_THRESHOLDS: LabelConsolidationThresholds = {
  strongThreshold: 1.5,
  positiveThreshold: 0.5,
  minStrongMixed: 1.0,
};

export interface QualityWeights {
  high: number;
  medium: number;
  low: number;
}

export const DEFAULT_QUALITY_WEIGHTS: QualityWeights = {
  high: 1.0,
  medium: 0.6,
  low: 0.25,
};

/** Treat undefined as medium — pre-quality data lands here. */
export function qualityWeightOf(
  quality: ContentQuality | undefined,
  weights: QualityWeights = DEFAULT_QUALITY_WEIGHTS,
): number {
  if (quality === 'high') return weights.high;
  if (quality === 'low') return weights.low;
  // 'medium' or undefined
  return weights.medium;
}

/**
 * Collapse weighted evidence entries into a single sentiment. Sentiment
 * intensity table (multipliers applied to qualityWeight per entry):
 *
 *   StrongPositive   → +1.5 to P, contributes qualityWeight to S
 *   Positive         → +1.0 to P
 *   Mixed            → +0.5 to P AND +0.5 to N (no S/T contribution)
 *   Negative         → +1.0 to N
 *   StrongNegative   → +1.5 to N, contributes qualityWeight to T
 *   Neutral          → no contribution
 *
 * Decision (in order):
 *   1. S ≥ minStrongMixed AND T ≥ minStrongMixed → Mixed
 *   2. (P-N) ≥ strongThreshold AND S > 0 → StrongPositive
 *   3. (P-N) ≥ positiveThreshold → Positive
 *   4. (N-P) ≥ strongThreshold AND T > 0 → StrongNegative
 *   5. (N-P) ≥ positiveThreshold → Negative
 *   6. P > 0 AND N > 0 → Mixed (competing weak signals)
 *   7. otherwise → Neutral
 */
export function consolidateSentiment(
  entries: WeightedEntry[],
  thresholds: LabelConsolidationThresholds = DEFAULT_LABEL_CONSOLIDATION_THRESHOLDS,
): Sentiment {
  let P = 0;
  let N = 0;
  let S = 0;
  let T = 0;

  for (const { sentiment, qualityWeight } of entries) {
    switch (sentiment) {
      case Sentiment.StrongPositive:
        P += qualityWeight * 1.5;
        S += qualityWeight;
        break;
      case Sentiment.Positive:
        P += qualityWeight * 1.0;
        break;
      case Sentiment.Mixed:
        P += qualityWeight * 0.5;
        N += qualityWeight * 0.5;
        break;
      case Sentiment.Negative:
        N += qualityWeight * 1.0;
        break;
      case Sentiment.StrongNegative:
        N += qualityWeight * 1.5;
        T += qualityWeight;
        break;
      case Sentiment.Neutral:
        // no contribution
        break;
    }
  }

  if (S >= thresholds.minStrongMixed && T >= thresholds.minStrongMixed) {
    return Sentiment.Mixed;
  }

  const net = P - N;

  if (net >= thresholds.strongThreshold && S > 0) {
    return Sentiment.StrongPositive;
  }
  if (net >= thresholds.positiveThreshold) {
    return Sentiment.Positive;
  }
  if (net <= -thresholds.strongThreshold && T > 0) {
    return Sentiment.StrongNegative;
  }
  if (net <= -thresholds.positiveThreshold) {
    return Sentiment.Negative;
  }

  if (P > 0 && N > 0) {
    return Sentiment.Mixed;
  }

  return Sentiment.Neutral;
}
