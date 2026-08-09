import { Injectable } from "@nestjs/common";
import { search as fuzzySearch } from "fast-fuzzy";
import { compact, isEmpty, sumBy } from "lodash";
import { RelevanceTermsService } from "./relevance-terms.service";
import { DeliberationTermsService } from "./deliberation-terms.service";
import { BrandCacheService } from "@ebike-backend/product";
import { RelevanceTerm } from "@ebike-backend/database";

const PRODUCT_REGEX =
  /\b(?:[A-Za-z]{1,4}-?\d{2,5}[A-Za-z]{0,4}|[A-Za-z]{2,6}\d[A-Za-z0-9]{1,5}|[A-Za-z]{1,3}\d{2,4}|[A-Za-z]{2,5}-\d{2,4}|[A-Za-z]{1,4}\d{1,2}[A-Za-z]{1,2})\b/gi;

const PRODUCT_NOISE_WORDS = new Set([
  "from",
  "at",
  "marked",
  "down",
  "price",
  "only",
  "now",
  "sale",
  "off",
  "was",
  "save",
  "discount",
  "€",
  "$",
  "eur",
  "usd",
  "gbp",
  "for",
  "the",
]);

const REVIEW_INTENT_PHRASES = [
  "i bought",
  "i used",
  "my experience",
  "pros",
  "cons",
  "worth it",
  "recommend",
  "review",
  "compared to",
];

const NEGATIVE_CONTEXT_PHRASES = [
  "for sale",
  "deal",
  "coupon",
  "discount",
  "shipping",
  "in stock",
  "where can i buy",
  "anyone selling",
];

const NEGATION_PREFIXES = [
  "not ",
  "don't ",
  "doesn't ",
  "didn't ",
  "wasn't ",
  "isn't ",
  "aren't ",
  "won't ",
  "can't ",
  "no ",
  "never ",
  "barely ",
  "hardly ",
];

const META_DISCLAIMER_PHRASES = [
  "cannot be relied upon",
  "can't be relied upon",
  "grain of salt",
  "don't know much",
  "not an expert",
  "i'm no expert",
  "could be wrong",
  "might be wrong",
  "not sure if",
  "i guess",
  "probably wrong",
];

const OWNERSHIP_PHRASES = [
  "i have the",
  "i got the",
  "i bought the",
  "i own the",
  "i purchased",
  "i received",
  "just got the",
  "i've had the",
  "my ", // Will match "my [brand]" patterns
];

const COMPARISON_PHRASES = [
  "coming from",
  "compared to",
  " vs ",
  " vs. ",
  "versus",
  "better than",
  "worse than",
  "over the",
  "instead of",
];

const SPEC_PATTERN =
  /\d+\s*(hz|ms|inch|"|nit|cd\/m|gb|tb|mm|cm|kg|lbs|watts?|mah|mbps|fps)/gi;

import { RelevanceConfigService } from "./relevance-config.service";

export interface RelevanceCalculatorOptions {
  maxScore?: number;
  termsOverride?: RelevanceTerm[];
  useBrands?: boolean;
  additionalTerms?: RelevanceTerm[];
}

export interface RelevanceResult {
  score: number;
  components: {
    fuzzyScore: number;
    diversity: number;
    reviewIntentMultiplier: number;
    penaltyMultiplier: number;
    deliberationMultiplier: number;
    depthMultiplier: number;
    disclaimerPenalty: number;
    ownershipMultiplier: number;
    comparisonMultiplier: number;
    brandBoost: number;
    productTermContribution: number;
    topTerms: { keyword: string; score: number; maxScore: number }[];
  };
}

interface TermScore {
  keyword: string;
  score: number;
  maxScore: number;
}

@Injectable()
export class RelevanceCalculatorService {
  constructor(
    private readonly brandCacheService: BrandCacheService,
    private readonly relevanceTermsService: RelevanceTermsService,
    private readonly deliberationTermsService: DeliberationTermsService,
    private readonly relevanceConfig: RelevanceConfigService,
  ) {}

  public async calculateRelevance(
    contents: string[],
    options: RelevanceCalculatorOptions = {},
  ): Promise<RelevanceResult> {
    if (isEmpty(contents)) return this.buildEmptyResult(1);

    const {
      maxScore = 100,
      termsOverride,
      useBrands = true,
      additionalTerms = [],
    } = options;

    // === 1. NORMALIZATION ===
    const normalized = compact(contents.map((c) => c?.toLowerCase?.() ?? ""));
    if (isEmpty(normalized)) return this.buildEmptyResult(1);

    const combinedText = normalized.join(" ");

    // === 2. TERM EXTRACTION ===
    const baseTerms = termsOverride?.length
      ? termsOverride
      : this.relevanceTermsService.getDefaultTerms();

    const extendedTerms = this.relevanceTermsService.getMergedTerms(
      baseTerms,
      additionalTerms,
    );

    const productTerms = this.extractProductModelTerms(normalized);
    const cappedProductTerms = this.capProductTermWeights(productTerms);
    const allTerms = [...extendedTerms, ...cappedProductTerms];

    // === 3. BRAND NAMES (needed early for proximity scoring) ===
    const brandNames = useBrands
      ? await this.getMatchedBrandNames(combinedText)
      : [];

    // === 4. TERM SCORING (with negation + proximity) ===
    const termScores = this.calculateTermScores(
      allTerms,
      normalized,
      cappedProductTerms,
      brandNames,
    );

    // === 5. ADAPTIVE TOP-N ===
    const meaningfulMatches = termScores.filter((t) => t.score > 0).length;
    const adaptiveTopN = Math.max(
      3,
      Math.min(12, Math.round(meaningfulMatches * 0.4)),
    );
    const topTerms = this.pickTopTerms(termScores, adaptiveTopN);

    // === 6. FUZZY SCORE with product term cap ===
    const fuzzyTotal = sumBy(topTerms, "score");
    const fuzzyMax = sumBy(topTerms, "maxScore") || 1;
    let fuzzyScore = Math.min(1, fuzzyTotal / fuzzyMax);

    const productTermContribution = this.calculateProductTermContribution(
      termScores,
      cappedProductTerms,
    );
    const PRODUCT_TERM_CAP = this.relevanceConfig.config.productTermCap;
    if (productTermContribution > PRODUCT_TERM_CAP) {
      const excess = productTermContribution - PRODUCT_TERM_CAP;
      fuzzyScore = Math.max(0, fuzzyScore * (1 - excess));
    }

    // === 7. DIVERSITY METRIC (replaces coverage) ===
    const diversity = this.calculateDiversity(termScores);

    // === 8. BLENDED BASE SCORE ===
    const blended = fuzzyScore * 0.7 + diversity * 0.3;

    // === 9. MULTIPLIERS (all graduated) ===
    const { multiplier: deliberationMultiplier } =
      this.deliberationTermsService.computeMultiplier(normalized);

    const reviewIntentMultiplier =
      this.calculateReviewIntentMultiplier(combinedText);
    const penaltyMultiplier =
      this.calculateNegativeContextPenalty(combinedText);
    const depthMultiplier = this.calculateContentDepthMultiplier(combinedText);
    const disclaimerPenalty = this.calculateDisclaimerPenalty(combinedText);
    const ownershipMultiplier = this.calculateOwnershipMultiplier(combinedText);
    const comparisonMultiplier =
      this.calculateComparisonMultiplier(combinedText);

    const adjustedScore =
      blended *
      deliberationMultiplier *
      reviewIntentMultiplier *
      penaltyMultiplier *
      depthMultiplier *
      disclaimerPenalty *
      ownershipMultiplier *
      comparisonMultiplier;

    // === 10. BRAND BOOST ===
    const brandBoost = useBrands
      ? this.calculateBrandBoost(brandNames, fuzzyScore)
      : 0;

    const scoreWithBoost = adjustedScore * maxScore + brandBoost;

    // === 11. NON-LINEAR NORMALIZATION ===
    const rawRatio = Math.min(1, scoreWithBoost / maxScore);
    const normalizedRatio = Math.pow(rawRatio, 1.5);
    const finalScore = Math.round(
      Math.max(1, Math.min(maxScore, normalizedRatio * maxScore)),
    );

    return {
      score: finalScore,
      components: {
        fuzzyScore,
        diversity,
        reviewIntentMultiplier,
        penaltyMultiplier,
        deliberationMultiplier,
        depthMultiplier,
        disclaimerPenalty,
        ownershipMultiplier,
        comparisonMultiplier,
        brandBoost,
        productTermContribution,
        topTerms,
      },
    };
  }

  // ─── Term Scoring (negation detection + proximity weighting) ─────────

  private calculateTermScores(
    terms: RelevanceTerm[],
    contents: string[],
    productTerms: RelevanceTerm[],
    brandNames: string[],
  ): TermScore[] {
    const anchorMap = this.buildAnchorMap(contents, productTerms, brandNames);

    return terms.map(({ keyword, weight }) => {
      // For multi-word terms, use stricter threshold (0.9 vs 0.7)
      const threshold = keyword.includes(" ")
        ? 0.9
        : this.relevanceConfig.config.fuzzyThreshold;

      const matches = fuzzySearch(keyword, contents, {
        ignoreCase: true,
        threshold,
        returnMatchData: true,
      });

      if (isEmpty(matches)) {
        return {
          keyword,
          score: 0,
          maxScore: this.computeMaxPossibleScore(weight, contents.length),
        };
      }

      // Filter negated matches, validate multi-word terms, and apply proximity boost
      let similaritySum = 0;
      let validCount = 0;

      for (const match of matches) {
        const content = match.original ?? "";

        // Skip if negated
        if (this.isNegated(keyword, content)) continue;

        // For multi-word terms, ensure all words are present
        if (!this.matchesMultiWordTerm(keyword, content)) continue;

        // For high-weight terms (>2.0), require word boundaries
        if (weight > 2.0 && !this.hasWordBoundaries(content, keyword)) continue;

        const contentIdx = contents.indexOf(content);
        const proximityBoost =
          contentIdx >= 0 && anchorMap[contentIdx] ? 1.4 : 1.0;

        similaritySum += match.score * proximityBoost;
        validCount++;
      }

      if (validCount === 0) {
        return {
          keyword,
          score: 0,
          maxScore: this.computeMaxPossibleScore(weight, contents.length),
        };
      }

      const phraseBoost = keyword.includes(" ")
        ? Math.pow(1.5, (keyword.match(/ /g) || []).length)
        : 1;
      const frequencyBoost = Math.sqrt(validCount);
      const rawScore = similaritySum * weight * frequencyBoost;
      const maxScore = this.computeMaxPossibleScore(weight, contents.length);

      return {
        keyword,
        score: Math.min(rawScore, maxScore) * phraseBoost,
        maxScore,
      };
    });
  }

  /**
   * Pre-compute which content items contain product/brand mentions.
   * Used for proximity-weighted scoring: terms in sentences with
   * product/brand anchors get a 1.4x boost.
   */
  private buildAnchorMap(
    contents: string[],
    productTerms: RelevanceTerm[],
    brandNames: string[],
  ): boolean[] {
    return contents.map((content) => {
      const lower = content.toLowerCase();
      const hasProduct = productTerms.some((t) =>
        lower.includes(t.keyword.toLowerCase()),
      );
      const hasBrand = brandNames.some((b) => lower.includes(b));
      return hasProduct || hasBrand;
    });
  }

  /**
   * Check if a keyword match is negated by a preceding negation prefix.
   * Looks within 20 characters before the match position.
   */
  private isNegated(keyword: string, content: string): boolean {
    const lower = content.toLowerCase();
    const keyLower = keyword.toLowerCase();
    const matchIndex = lower.indexOf(keyLower);
    if (matchIndex <= 0) return false;

    const prefix = lower.substring(Math.max(0, matchIndex - 20), matchIndex);
    return NEGATION_PREFIXES.some((neg) => prefix.includes(neg));
  }

  /**
   * Check if a multi-word term has all words present in the content.
   * For single-word terms, returns true (allowing fuzzy matching).
   * For multi-word terms, requires all words to be present.
   *
   * Example: "love it" requires both "love" and "it" to be present
   * to avoid matching "would love to" which doesn't contain "it".
   */
  private matchesMultiWordTerm(keyword: string, content: string): boolean {
    if (!keyword.includes(" ")) return true; // Single word, use fuzzy

    const words = keyword.toLowerCase().split(" ");
    const contentLower = content.toLowerCase();
    return words.every((word) => contentLower.includes(word));
  }

  /**
   * Check if a match has word boundaries on both sides.
   * Used for high-weight terms to prevent partial word matches.
   *
   * Example: "love" with word boundaries matches "I love it"
   * but not "lovely" or "glove".
   */
  private hasWordBoundaries(text: string, match: string): boolean {
    const escaped = this.escapeRegExp(match);
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    return regex.test(text);
  }

  // ─── Graduated Multipliers ───────────────────────────────────────────

  /**
   * Graduated review intent multiplier (1.0x–1.30x).
   * Scales continuously with the number of intent phrases matched.
   */
  private calculateReviewIntentMultiplier(text: string): number {
    const lower = text.toLowerCase();
    const intentCount = REVIEW_INTENT_PHRASES.filter((p) =>
      lower.includes(p),
    ).length;
    return 1.0 + Math.min(0.3, intentCount * 0.05);
  }

  /**
   * Graduated negative context penalty (0.6x–1.0x).
   * Scales by match density per 100 words to distinguish
   * a detailed review mentioning "deal" once from a pure deal-seeking post.
   */
  private calculateNegativeContextPenalty(text: string): number {
    const lower = text.toLowerCase();
    const negCount = NEGATIVE_CONTEXT_PHRASES.filter((p) =>
      lower.includes(p),
    ).length;
    if (negCount === 0) return 1.0;

    const wordCount = text.split(/\s+/).length;
    const negDensity = negCount / (wordCount / 100);
    return Math.max(0.6, 1.0 - negDensity * 0.15);
  }

  // ─── Content Depth Bonus ─────────────────────────────────────────────

  /**
   * Content depth multiplier (1.0x–1.15x).
   * Rewards detailed, specific reviews using:
   * - Length signal: log-scale word count (saturates at ~500 words)
   * - Specificity signal: mentions of measurements, specs, numbers with units
   */
  private calculateContentDepthMultiplier(text: string): number {
    const words = text.split(/\s+/).length;
    const lengthScore = Math.min(1, Math.log(words + 1) / Math.log(500));

    const specCount = (text.match(SPEC_PATTERN) || []).length;
    const specificityScore = Math.min(1, specCount * 0.15);

    return 1.0 + lengthScore * 0.05 + specificityScore * 0.1;
  }

  /**
   * Disclaimer penalty (0.7^n multiplicative).
   * Detects meta-disclaimers that nullify the entire comment's credibility.
   * Examples: "My words cannot be relied upon", "I'm no expert", "take with a grain of salt"
   *
   * Each disclaimer reduces credibility by 30% (multiplicative)
   */
  private calculateDisclaimerPenalty(text: string): number {
    const lower = text.toLowerCase();
    const disclaimerCount = META_DISCLAIMER_PHRASES.filter((phrase) =>
      lower.includes(phrase),
    ).length;

    // Each disclaimer reduces credibility by 30% (multiplicative)
    return Math.pow(0.7, disclaimerCount);
  }

  /**
   * Ownership multiplier (1.0x–1.3x).
   * Boosts comments with clear ownership signals (first-hand experience).
   * Helps fix false negatives where genuine owner reviews were underscored.
   *
   * Examples:
   * - "I have the MSI MPG341" → 1.3x boost
   * - "I've had the monitor for a week" → 1.3x boost
   * - "Just got the LG" → 1.3x boost
   */
  private calculateOwnershipMultiplier(text: string): number {
    const lower = text.toLowerCase();
    const hasOwnership = OWNERSHIP_PHRASES.some((phrase) =>
      lower.includes(phrase),
    );
    return hasOwnership ? 1.3 : 1.0;
  }

  /**
   * Comparison multiplier (1.0x–1.2x).
   * Boosts comments that include comparisons (high value for buyers).
   * Helps identify detailed reviews that compare products.
   *
   * Examples:
   * - "Coming from a 165hz Acer Predator" → 1.2x boost
   * - "Better than the LG" → 1.2x boost
   * - "MSI vs Samsung" → 1.2x boost
   */
  private calculateComparisonMultiplier(text: string): number {
    const lower = text.toLowerCase();
    const comparisonCount = COMPARISON_PHRASES.filter((phrase) =>
      lower.includes(phrase),
    ).length;

    // 1+ comparisons = 1.2x boost
    return comparisonCount > 0 ? 1.2 : 1.0;
  }

  // ─── Diversity Metric (replaces coverage) ────────────────────────────

  /**
   * Category diversity score (0–1).
   * Measures how many *types* of signals are present rather than raw match count.
   * A comment touching intent + experience + sentiment + comparison is more
   * relevant than one matching 20 terms from the same category.
   */
  private calculateDiversity(termScores: TermScore[]): number {
    const matchedKeywords = new Set(
      termScores.filter((t) => t.score > 0).map((t) => t.keyword.toLowerCase()),
    );

    const categories = RelevanceTermsService.TERM_CATEGORIES;
    const categoryKeys = Object.keys(categories);
    const matchedCategories = Object.values(categories).filter((terms) =>
      terms.some((t) => matchedKeywords.has(t)),
    ).length;

    return matchedCategories / categoryKeys.length;
  }

  // ─── Brand Scoring ───────────────────────────────────────────────────

  private async getMatchedBrandNames(text: string): Promise<string[]> {
    const brands = await this.brandCacheService.getCachedBrands();
    const matched = new Set<string>();

    for (const brand of brands) {
      if (!brand?.name) continue;
      const regex = new RegExp(`\\b${this.escapeRegExp(brand.name)}\\b`, "i");
      if (regex.test(text)) {
        matched.add(brand.name.toLowerCase());
      }
    }

    return [...matched];
  }

  private calculateBrandBoost(
    brandNames: string[],
    fuzzyScore: number,
  ): number {
    const rawBoost = Math.min(2, brandNames.length * 0.5);
    return rawBoost * Math.max(0.5, fuzzyScore);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private pickTopTerms(termScores: TermScore[], topN: number): TermScore[] {
    return [...termScores].sort((a, b) => b.score - a.score).slice(0, topN);
  }

  private computeMaxPossibleScore(
    weight: number,
    contentLength: number,
  ): number {
    const maxOccurrences = Math.max(1, Math.round(contentLength / 20));
    const maxSimilaritySum = maxOccurrences * 1;
    const maxFrequencyBoost = Math.sqrt(maxOccurrences);
    return maxSimilaritySum * weight * maxFrequencyBoost;
  }

  private extractProductModelTerms(contents: string[]): RelevanceTerm[] {
    const freq: Record<string, number> = {};

    for (const text of contents) {
      for (const t of this.extractAllProductNames(text)) {
        freq[t] = (freq[t] ?? 0) + 1;
      }
    }

    return Object.keys(freq).map((keyword) => ({ keyword, weight: 1.0 }));
  }

  private capProductTermWeights(
    productTerms: RelevanceTerm[],
  ): RelevanceTerm[] {
    if (isEmpty(productTerms)) return [];
    return productTerms.map((term) => ({
      ...term,
      weight: Math.max(0.6, Math.min(1.0, term.weight * 0.8)),
    }));
  }

  private calculateProductTermContribution(
    termScores: TermScore[],
    productTerms: RelevanceTerm[],
  ): number {
    const productKeywords = new Set(productTerms.map((t) => t.keyword));
    const productScore = sumBy(
      termScores.filter((t) => productKeywords.has(t.keyword)),
      "score",
    );
    const totalScore = sumBy(termScores, "score") || 1;
    return productScore / totalScore;
  }

  private buildEmptyResult(
    score: number,
    components?: Partial<RelevanceResult["components"]>,
  ): RelevanceResult {
    return {
      score,
      components: {
        fuzzyScore: components?.fuzzyScore ?? 0,
        diversity: components?.diversity ?? 0,
        reviewIntentMultiplier: components?.reviewIntentMultiplier ?? 1.0,
        penaltyMultiplier: components?.penaltyMultiplier ?? 1.0,
        deliberationMultiplier: components?.deliberationMultiplier ?? 1.0,
        depthMultiplier: components?.depthMultiplier ?? 1.0,
        disclaimerPenalty: components?.disclaimerPenalty ?? 1.0,
        ownershipMultiplier: components?.ownershipMultiplier ?? 1.0,
        comparisonMultiplier: components?.comparisonMultiplier ?? 1.0,
        brandBoost: components?.brandBoost ?? 0,
        productTermContribution: components?.productTermContribution ?? 0,
        topTerms: components?.topTerms ?? [],
      },
    };
  }

  private extractAllProductNames(text: string): string[] {
    if (!text) return [];

    const rawMatches = text.match(PRODUCT_REGEX) || [];
    if (isEmpty(rawMatches)) return [];

    const freq: Record<string, number> = {};

    for (const raw of rawMatches) {
      let m = raw.trim().replace(/[^a-z0-9-]/gi, "");
      if (!m) continue;
      m = m.toLowerCase();

      const hasLetter = /[a-z]/i.test(m);
      const hasDigit = /\d/.test(m);
      const hasHyphenDigit = /[a-z]+-[0-9]/i.test(m);
      if (!((hasLetter && hasDigit) || hasHyphenDigit)) continue;

      const alphaOnly = m.replace(/[^a-z]/g, "");
      if (alphaOnly && alphaOnly.length > 1) {
        if (PRODUCT_NOISE_WORDS.has(alphaOnly)) continue;
      }

      if (/^from\d+$/i.test(m) || /^at\d+$/i.test(m)) continue;

      const englishNoise = new Set(["percent", "percentoff", "discount"]);
      if (englishNoise.has(alphaOnly)) continue;

      if (m.length < 3) continue;

      freq[m] = (freq[m] ?? 0) + 1;
    }

    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .map(([term]) => term);
  }

  private escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
