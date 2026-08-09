import { Injectable } from "@nestjs/common";
import {
  ProductCategory,
  ProductCategoryRepository,
  Thread,
  ThreadRepository,
} from "@ebike-backend/database";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { CategoryConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import { nameOf } from "@ebike-backend/utils";

export interface CategoryAllocation {
  category: ProductCategory;
  searchPriority: number;
  backlog: number;
  normalizedPriority: number;
  deficitScore: number;
  score: number;
  keywordCount: number;
}

interface BacklogRow {
  categoryId: string;
  backlog: string;
}

const DEFAULTS = {
  totalKeywordsPerRun: 100,
  maxKeywordsPerCategory: 20,
  minKeywordsPerCategory: 2,
  targetBacklog: 100,
};

/**
 * Splits the global `totalKeywordsPerRun` budget across enabled categories
 * for the keyword-research scheduler run.
 *
 * Allocation = equal-weighted sum of
 *  - normalizedPriority = searchPriority / 10  (in [0, 1])
 *  - deficitScore       = clamp01(1 - backlog / targetBacklog)
 *
 * where backlog is the count of threads currently in status SELECTED for
 * the category — LLM-validated, awaiting extraction, the real "useful
 * pipeline depth". NEW is excluded since many of those will be rejected by
 * Stage-2 and would inflate the apparent backlog.
 *
 * Proportional allocation is clamped to [minKeywordsPerCategory,
 * maxKeywordsPerCategory] and the residual is redistributed to the
 * highest-scoring categories until the sum matches the budget.
 */
@Injectable()
export class KeywordBudgetAllocator {
  private readonly logger = new CustomLogger(KeywordBudgetAllocator.name);

  constructor(
    private readonly productCategoryRepository: ProductCategoryRepository,
    private readonly threadRepository: ThreadRepository,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  async allocate(options?: {
    categorySlugs?: string[];
    overrideTotal?: number;
  }): Promise<CategoryAllocation[]> {
    const config = this.dynamicConfigService.keywordResearch;
    const totalBudget =
      options?.overrideTotal ??
      config?.totalKeywordsPerRun ??
      DEFAULTS.totalKeywordsPerRun;
    const maxPerCategory =
      config?.maxKeywordsPerCategory ?? DEFAULTS.maxKeywordsPerCategory;
    const minPerCategory =
      config?.minKeywordsPerCategory ?? DEFAULTS.minKeywordsPerCategory;
    const targetBacklog = config?.targetBacklog ?? DEFAULTS.targetBacklog;

    const candidates = await this.loadEligibleCategories(
      options?.categorySlugs,
    );

    this.logger.debug("Allocator inputs", {
      totalBudget,
      targetBacklog,
      minPerCategory,
      maxPerCategory,
      eligibleCategoryCount: candidates.length,
    });

    if (candidates.length === 0) {
      return [];
    }

    const categoryIds = candidates.map((category) => category.id);
    const backlogMap = await this.loadBacklog(categoryIds);

    const scored = candidates.map((category) => {
      const backlog = backlogMap.get(category.id) ?? 0;
      const normalizedPriority = category.searchPriority / 10;
      const deficitScore = Math.max(
        0,
        Math.min(1, 1 - backlog / targetBacklog),
      );
      const score = normalizedPriority + deficitScore;
      return {
        category,
        searchPriority: category.searchPriority,
        backlog,
        normalizedPriority,
        deficitScore,
        score,
      };
    });

    const totalScore = scored.reduce((sum, row) => sum + row.score, 0);

    if (totalScore === 0) {
      this.logger.warn("All categories scored 0 — no allocation possible", {
        totalBudget,
      });
      return [];
    }

    // Raw proportional allocation, clamped per-category.
    const draft = scored.map((row) => {
      const rawAllocation = totalBudget * (row.score / totalScore);
      const clamped = Math.max(
        minPerCategory,
        Math.min(maxPerCategory, Math.round(rawAllocation)),
      );
      return { ...row, keywordCount: clamped };
    });

    const redistributed = this.redistributeResidual(
      draft,
      totalBudget,
      minPerCategory,
      maxPerCategory,
    );

    this.logger.debug("Per-category scores", {
      rows: redistributed.map((row) => ({
        slug: row.category.slug,
        searchPriority: row.searchPriority,
        backlog: row.backlog,
        normalizedPriority: row.normalizedPriority,
        deficitScore: row.deficitScore,
        score: row.score,
        keywordCount: row.keywordCount,
      })),
    });

    const assigned = redistributed.reduce(
      (sum, row) => sum + row.keywordCount,
      0,
    );

    this.logger.log("Allocation finished", {
      totalBudget,
      assigned,
      residualRedistributed: assigned - totalBudget,
    });

    // Drop categories that ended at 0 (only possible if minKeywordsPerCategory = 0).
    return redistributed.filter((row) => row.keywordCount > 0);
  }

  private async loadEligibleCategories(
    slugFilter?: string[],
  ): Promise<ProductCategory[]> {
    const all = await this.productCategoryRepository.repo
      .createQueryBuilder("category")
      .where("category.enabled = true")
      .andWhere('category."searchEnabled" = true')
      .getMany();

    return all.filter((category) => {
      if (!this.categoryConfigService.getSearchConfig(category.slug)) {
        this.logger.warn(
          "Category has searchEnabled=true but no search.json — silently excluded from allocation",
          {
            categorySlug: category.slug,
            categoryId: category.id,
          },
        );
        return false;
      }
      if (slugFilter && !slugFilter.includes(category.slug)) {
        return false;
      }
      return true;
    });
  }

  private async loadBacklog(
    categoryIds: string[],
  ): Promise<Map<string, number>> {
    if (categoryIds.length === 0) return new Map();

    // `thread_id` / `category_id` are explicit @JoinColumn renames on
    // ThreadProductCategory; nameOf only knows the property names, not the
    // mapped snake_case columns, so those stay hardcoded here.
    const rows = await this.threadRepository.repo.query<BacklogRow[]>(
      `
      SELECT tpc.category_id AS "categoryId",
             COUNT(t.${nameOf<Thread>("id")}) AS backlog
      FROM thread t
      INNER JOIN thread_product_category tpc ON tpc.thread_id = t.${nameOf<Thread>("id")}
      WHERE tpc.category_id = ANY($1::uuid[])
        AND t.${nameOf<Thread>("status")} = 'selected'
      GROUP BY tpc.category_id
      `,
      [categoryIds],
    );

    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.categoryId, Number(row.backlog));
    }
    return map;
  }

  /**
   * After clamping, the total keyword count may not equal the budget. Walk
   * categories sorted by score (best first) and adjust by ±1 until we match,
   * respecting min/max bounds.
   */
  private redistributeResidual(
    draft: CategoryAllocation[],
    totalBudget: number,
    minPerCategory: number,
    maxPerCategory: number,
  ): CategoryAllocation[] {
    const ordered = [...draft].sort((a, b) => b.score - a.score);
    let assigned = ordered.reduce((sum, row) => sum + row.keywordCount, 0);

    if (assigned === totalBudget) return ordered;

    const direction = assigned < totalBudget ? +1 : -1;
    let safetyCounter =
      ordered.length * Math.abs(maxPerCategory - minPerCategory) + 1;

    while (assigned !== totalBudget && safetyCounter > 0) {
      let adjusted = false;
      for (const row of ordered) {
        if (assigned === totalBudget) break;
        const next = row.keywordCount + direction;
        if (next < minPerCategory || next > maxPerCategory) continue;
        row.keywordCount = next;
        assigned += direction;
        adjusted = true;
      }
      if (!adjusted) break;
      safetyCounter--;
    }

    return ordered;
  }
}
