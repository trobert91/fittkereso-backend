import { Injectable } from "@nestjs/common";
import { ProductCategory } from "@ebike-backend/database";
import { compact } from "lodash";
import { CategoryCacheService } from "../category/category-cache.service";

const MATCH_THRESHOLD = 0.5;

/**
 * Single service for matching a free-text category hint to a ProductCategory
 * entity using in-memory scoring (Jaccard, prefix containment, bigram Dice).
 *
 * Replaces both the standalone `findMatchingCategory` in SubtreeExtractionService
 * and the former DB-based `resolveByName()` similarity query.
 */
@Injectable()
export class CategoryNameMatcherService {
  constructor(private readonly categoryCache: CategoryCacheService) {}

  /**
   * Match a category hint against a provided list of categories.
   * Returns the best-matching category or undefined if no score >= threshold.
   */
  matchByName(
    hint: string,
    categories: ProductCategory[],
  ): ProductCategory | undefined {
    const normalizedHint = normalizeCategoryString(hint);
    const hintWords = compact(normalizedHint.split(" "));

    let bestCategory: ProductCategory | undefined;
    let bestScore = 0;

    for (const category of categories) {
      const normalizedName = normalizeCategoryString(category.name);

      // 1. Exact match
      if (normalizedHint === normalizedName) return category;

      const nameWords = compact(normalizedName.split(" "));

      // 2. Word-overlap Jaccard: |intersection| / |union|
      const hintSet = new Set(hintWords);
      const nameSet = new Set(nameWords);
      const intersectionSize = [...hintSet].filter((word) =>
        nameSet.has(word),
      ).length;
      const unionSize = new Set([...hintWords, ...nameWords]).size;
      const wordJaccard = unionSize > 0 ? intersectionSize / unionSize : 0;

      // 3. Prefix containment — hintWords is a prefix of nameWords or vice versa
      const minLen = Math.min(hintWords.length, nameWords.length);
      const prefixMatches = hintWords
        .slice(0, minLen)
        .filter((word, index) => word === nameWords[index]).length;
      const prefixScore =
        minLen > 0 && prefixMatches === minLen
          ? minLen / Math.max(hintWords.length, nameWords.length)
          : 0;

      // 4. Character bigram Dice
      const bigramScore = bigramDiceCoefficient(normalizedHint, normalizedName);

      const score = Math.max(wordJaccard, prefixScore, bigramScore);

      if (score > bestScore) {
        bestScore = score;
        bestCategory = category;
      }
    }

    return bestScore >= MATCH_THRESHOLD ? bestCategory : undefined;
  }

  /**
   * Convenience: match against all cached categories.
   */
  async matchFromAllCategories(
    hint: string,
  ): Promise<ProductCategory | undefined> {
    const categories = await this.categoryCache.getAllCategories();
    return this.matchByName(hint, categories);
  }

  /**
   * Convenience: match against extraction-enabled cached categories only.
   */
  async matchFromEnabledCategories(
    hint: string,
  ): Promise<ProductCategory | undefined> {
    const categories =
      await this.categoryCache.getExtractionEnabledCategories();
    return this.matchByName(hint, categories);
  }
}

// ─── Scoring Helpers ───────────────────────────────────────────────────────

function normalizeCategoryString(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigramDiceCoefficient(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.substring(i, i + 2);
    bigramsA.set(bigram, (bigramsA.get(bigram) ?? 0) + 1);
  }

  const bigramsB = new Map<string, number>();
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.substring(i, i + 2);
    bigramsB.set(bigram, (bigramsB.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (const [bigram, countA] of bigramsA) {
    intersection += Math.min(countA, bigramsB.get(bigram) ?? 0);
  }

  return (2 * intersection) / (a.length - 1 + b.length - 1);
}
