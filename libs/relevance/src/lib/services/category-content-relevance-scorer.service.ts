import { Injectable } from "@nestjs/common";
import { NegativeTerm, ProductCategory } from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { normalize } from "@ebike-backend/utils";
import { search as fuzzySearch } from "fast-fuzzy";
import { chain, isEmpty } from "lodash";
import { ScoringConfigService } from "../scoring-config.service";

interface WeightedTerm {
  term: string;
  weight: number;
  exclusive: boolean;
}

export interface ScoredTerm {
  term: string;
  /** Final score contribution after frequency and phrase boost. */
  score: number;
  /** Reference scale used by the aggregate normalizer for this term (kept for diagnostic display). */
  maxScore: number;
  exclusive: boolean;
  matchCount: number;
  avgSimilarity: number;
}

@Injectable()
export class CategoryContentRelevanceScorerService {
  constructor(
    private readonly scoringConfig: ScoringConfigService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  /**
   * Score a category against normalized content on a 0-100 scale.
   *
   * The scale is *absolute*, not per-category-config: a category whose config
   * lists 30 terms is not penalized vs. a category that lists 5. Each term's
   * `maxScore` (the saturation target for that term) scales with corpus size,
   * so categories compete on whether their terms saturate at the *expected*
   * rate for the corpus — not whether they happen to match a fixed reference.
   *
   * Pipeline:
   *   1. Build deduplicated term list from relevanceTerms / name / aliases /
   *      keywordIdentifiers (priority order).
   *   2. Score each term: avgSimilarity × weight × log2(1+matches) × phraseBoost,
   *      capped at the per-term `maxScore` = weight × log2(1+expectedMatches)
   *      × phraseBoost. `expectedMatches` scales with corpus size: a 100-comment
   *      thread expects ~5 matches per term for a category that's truly focused.
   *      This prevents a single heavily-mentioned term from saturating a
   *      whole category in a busy general-purpose subreddit.
   *   3. Take the top-K *matched* terms.
   *   4. Aggregate ratio = Σ(scores) / Σ(maxScores), then exclusive bonus +
   *      negative penalty.
   */
  public getRelevance(
    category: ProductCategory,
    contents: string[],
  ): CategoryRelevance | undefined {
    if (isEmpty(contents)) return undefined;

    const terms = this.buildTerms(category);
    if (isEmpty(terms)) return undefined;

    const scoredTerms = terms.map((term) => this.scoreTerm(term, contents));
    const matched = scoredTerms.filter((term) => term.score > 0);

    if (isEmpty(matched)) return undefined;

    const config = this.scoringConfig.categoryRelevance;
    const topTerms = matched
      .sort((a, b) => b.score - a.score)
      .slice(0, config.topKeywordCount);

    const rawTotal = topTerms.reduce((sum, term) => sum + term.score, 0);
    const target = topTerms.reduce((sum, term) => sum + term.maxScore, 0);

    let relevance = target > 0 ? Math.min(1, rawTotal / target) : 0;

    const exclusiveMatchCount = topTerms.filter(
      (term) => term.exclusive,
    ).length;
    relevance = Math.min(
      1,
      relevance + exclusiveMatchCount * config.exclusiveTermBoost,
    );

    const categoryConfig = this.categoryConfigService.getConfig(category.slug);
    const negativePenalty = this.calculateNegativePenalty(
      categoryConfig?.negativeTerms ?? [],
      contents,
    );
    relevance *= negativePenalty;

    return {
      relevance: Math.round(Math.min(relevance, 1) * 100),
      topTerms,
      exclusiveMatchCount,
      negativePenalty,
    };
  }

  /**
   * Score every provided category against the corpus, returning matched results
   * sorted by relevance descending. Categories that did not score above zero
   * are omitted from the output entirely.
   */
  public resolveByContent(
    contentParts: string[],
    allCategories: ProductCategory[],
  ): CategoryResolutionResult[] {
    if (isEmpty(contentParts) || isEmpty(allCategories)) return [];

    const normalizedContent = contentParts.map((part) => normalize(part));

    const scoredCategories = allCategories.map((category) => {
      const relevance = this.getRelevance(category, normalizedContent);
      if (!relevance) return undefined;
      return { category, ...relevance };
    });

    return chain(scoredCategories)
      .filter(
        (result): result is CategoryResolutionResult => result !== undefined,
      )
      .orderBy((result) => result.relevance, "desc")
      .value();
  }

  // ─── Term Building ───────────────────────────────────────────────────────────

  private buildTerms(category: ProductCategory): WeightedTerm[] {
    const config = this.scoringConfig.categoryRelevance;
    const categoryConfig = this.categoryConfigService.getConfig(category.slug);
    const terms: WeightedTerm[] = [];
    const seen = new Set<string>();

    const addTerm = (
      term: string,
      weight: number,
      exclusive: boolean,
    ): void => {
      const normalized = normalize(term);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      terms.push({ term: normalized, weight, exclusive });
    };

    for (const relevanceTerm of categoryConfig?.relevanceTerms ?? []) {
      addTerm(
        relevanceTerm.keyword,
        relevanceTerm.weight,
        relevanceTerm.exclusive ?? false,
      );
    }
    if (category.name) {
      addTerm(category.name, config.categoryNameWeight, false);
    }
    for (const alias of category.aliases ?? []) {
      if (alias) addTerm(alias, config.categoryAliasWeight, false);
    }
    for (const keyword of categoryConfig?.keywordIdentifiers ?? []) {
      if (keyword) addTerm(keyword, config.keywordIdentifierWeight, false);
    }

    return terms;
  }

  // ─── Per-Term Scoring ────────────────────────────────────────────────────────

  private scoreTerm(
    weightedTerm: WeightedTerm,
    contents: string[],
  ): ScoredTerm {
    const { term, weight, exclusive } = weightedTerm;
    const config = this.scoringConfig.categoryRelevance;

    const phraseBoost = this.computePhraseBoost(term, config.phraseBoostBase);
    const expectedMatches = Math.max(
      config.referenceMatchesPerTerm,
      Math.round(contents.length / config.referenceCorpusDivisor),
    );
    // `maxScore` deliberately excludes `phraseBoost` so that phrase terms lift
    // the aggregate ratio: their score multiplies by phraseBoost while their
    // contribution to the denominator does not.
    const maxScore = weight * Math.log2(1 + expectedMatches);

    const matches = fuzzySearch(term, contents, {
      ignoreCase: true,
      threshold: config.fuzzyThreshold,
      returnMatchData: true,
    });

    if (matches.length === 0) {
      return {
        term,
        score: 0,
        maxScore,
        exclusive,
        matchCount: 0,
        avgSimilarity: 0,
      };
    }

    const similaritySum = matches.reduce((sum, match) => sum + match.score, 0);
    const avgSimilarity = similaritySum / matches.length;

    const frequencyFactor = Math.log2(1 + matches.length);
    const rawScore = avgSimilarity * weight * frequencyFactor;
    const score = Math.min(rawScore, maxScore) * phraseBoost;

    return {
      term,
      score,
      maxScore,
      exclusive,
      matchCount: matches.length,
      avgSimilarity,
    };
  }

  private computePhraseBoost(term: string, base: number): number {
    if (!term.includes(" ")) return 1.0;
    const spaceCount = (term.match(/ /g) ?? []).length;
    return Math.pow(base, spaceCount);
  }

  // ─── Negative Penalty ────────────────────────────────────────────────────────

  private calculateNegativePenalty(
    negativeTerms: NegativeTerm[],
    contents: string[],
  ): number {
    if (negativeTerms.length === 0) return 1.0;

    const config = this.scoringConfig.categoryRelevance;
    let penalty = 1.0;

    for (const negativeTerm of negativeTerms) {
      const matches = fuzzySearch(normalize(negativeTerm.keyword), contents, {
        ignoreCase: true,
        threshold: config.fuzzyThreshold,
        returnMatchData: true,
      });

      if (matches.length > 0) {
        penalty *= negativeTerm.penalty;
      }
    }

    return Math.max(config.negativeTermFloor, penalty);
  }
}

export interface CategoryRelevance {
  relevance: number;
  topTerms: ScoredTerm[];
  exclusiveMatchCount: number;
  negativePenalty: number;
}

export interface CategoryResolutionResult extends CategoryRelevance {
  category: ProductCategory;
}
