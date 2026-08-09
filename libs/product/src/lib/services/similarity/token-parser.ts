import { isEmpty } from 'lodash';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface TokenParserConfig {
  numericTokenRules: Array<{
    pattern: RegExp;
    weight: number;
    critical: boolean;
  }>;
}

export interface ParsedTokens {
  words: string[];
  raw: string;
  valid: boolean;
  numericCount: number;
  criticalNumericTokens: string[];
  criticalAlphaTokens: string[];
  suffixAlphaTokens: string[];
}

// ─── Pure Functions ──────────────────────────────────────────────────────────

/**
 * Basic text normalization.
 * Collapses whitespace between letter-groups and digit-groups so
 * "MPG 341CQPX" normalizes the same as "MPG341CQPX".
 */
export function basicNormalization(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/([a-z])\s+(\d)/gi, '$1$2')
    .replace(/(\d)\s+([a-z])/gi, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip brand prefix (case-insensitive) from text before normalization.
 */
export function removeBrand(text: string, brand: string | undefined): string {
  if (!text) return '';

  if (brand) {
    const brandLower = brand.toLowerCase();
    const textLower = text.toLowerCase();
    if (textLower.startsWith(brandLower)) {
      text = text.substring(brand.length).trim();
    }
  }

  return text.trim();
}

/**
 * Parse a normalized string into tokens with critical token detection.
 * Equivalent to InputNormalizationService.parseModelCode().
 */
export function parseTokens(
  normalized: string,
  config: TokenParserConfig,
): ParsedTokens {
  if (!normalized) {
    return {
      words: [],
      raw: '',
      valid: false,
      numericCount: 0,
      criticalNumericTokens: [],
      criticalAlphaTokens: [],
      suffixAlphaTokens: [],
    };
  }

  const words =
    normalized.match(/[a-z]+|\d+/gi)?.map((word) => word.toLowerCase()) ?? [];

  if (isEmpty(words)) {
    return {
      words: [],
      raw: normalized,
      valid: false,
      numericCount: 0,
      criticalNumericTokens: [],
      criticalAlphaTokens: [],
      suffixAlphaTokens: [],
    };
  }

  const numericCount = words.filter((word) => /\d/.test(word)).length;

  const criticalNumericTokens = words.filter((word) =>
    config.numericTokenRules.some(
      (rule) => rule.critical && rule.pattern.test(word),
    ),
  );

  // Pure-alpha tokens that immediately precede a digit-containing token are model-line
  // identifiers (e.g. "mpg" in "mpg341cqpx") and must match exactly.
  const criticalAlphaTokens = words.filter((word, idx) => {
    if (!/^[a-z]+$/.test(word)) return false;
    const nextWord = words[idx + 1];
    return nextWord !== undefined && /\d/.test(nextWord);
  });

  // Pure-alpha tokens that appear after the first numeric token (e.g. "cqp" in "mag341cqp").
  const firstNumericIdx = words.findIndex((word) => /\d/.test(word));
  const suffixAlphaTokens =
    firstNumericIdx === -1
      ? []
      : words.filter(
          (word, idx) => idx > firstNumericIdx && /^[a-z]+$/.test(word),
        );

  return {
    words,
    raw: normalized,
    valid: true,
    numericCount,
    criticalNumericTokens,
    criticalAlphaTokens,
    suffixAlphaTokens,
  };
}

/**
 * Get per-token weights from category-specific numeric token rules.
 * Returns the max matching rule weight for each word, defaulting to 1.0.
 */
export function getTokenWeights(
  words: string[],
  config: TokenParserConfig,
): number[] {
  return words.map((word) => {
    let maxWeight = 1.0;
    for (const rule of config.numericTokenRules) {
      if (rule.pattern.test(word)) {
        maxWeight = Math.max(maxWeight, rule.weight);
      }
    }
    return maxWeight;
  });
}
