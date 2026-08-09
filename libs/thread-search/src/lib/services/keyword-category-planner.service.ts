import { Injectable } from "@nestjs/common";
import { ProductCategory } from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { CustomLogger } from "@ebike-backend/logger";
import { KeywordStatsService, type KeywordStat } from "./keyword-stats.service";
import {
  KeywordCooldownService,
  type CooldownEntry,
} from "./keyword-cooldown.service";
import { TopProductSamplerService } from "./top-product-sampler.service";
import {
  KeywordPlannerService,
  type SearchedKeywordSummary,
} from "./keyword-planner.service";

export interface CategoryPlanInputs {
  baseKeywords: string[];
  topProducts: string[];
  searchedKeywords: SearchedKeywordSummary[];
  requestCount: number;
  allocatedCount: number;
  overFetchMultiplier: number;
  topProductSampleSize: number;
  yieldHistoryWeeks: number;
  cooldownDays: number;
}

const DEFAULTS = {
  overFetchMultiplier: 1.5,
  topProductSampleSize: 12,
  yieldHistoryWeeks: 8,
  cooldownDays: 21,
};

export interface CategoryPlanOutput {
  /** Keywords the planner returned, in priority order. */
  plannedKeywords: string[];
  /** Planner output after cooldown filtering. */
  survivors: string[];
  /** Survivors sliced to `allocatedCount` — the set the orchestrator would actually search. */
  sliced: string[];
  /** Keywords from `plannedKeywords` that were dropped by the active cooldown set. */
  droppedByCooldown: string[];
  /** USD cost of the planner LLM call. */
  plannerCost: number;
  /** Wall-clock duration of the planner LLM call in milliseconds. */
  plannerLatencyMs: number;
  /** Model used for the planner call (after dynamic-config resolution). */
  plannerModel: string;
  /** Raw inputs forwarded to the planner — useful for debug surfacing. */
  inputs: CategoryPlanInputs;
  /** Active cooldown entries that were considered when filtering. */
  cooldown: CooldownEntry[];
  /** Raw per-keyword stats from the past `yieldHistoryWeeks` weeks. */
  stats: KeywordStat[];
}

/**
 * Plans the keyword list for a single category — everything the weekly
 * orchestrator does up to (but not including) the side-effecting Reddit
 * search execution and cooldown persistence.
 *
 * Extracted from `KeywordResearchOrchestrator.processCategory` so the same
 * planning pipeline can be invoked dry-run from an admin debug endpoint
 * without firing real searches or writing cooldown rows.
 */
@Injectable()
export class KeywordCategoryPlannerService {
  private readonly logger = new CustomLogger(
    KeywordCategoryPlannerService.name,
  );

  constructor(
    private readonly statsService: KeywordStatsService,
    private readonly cooldownService: KeywordCooldownService,
    private readonly topProductSampler: TopProductSamplerService,
    private readonly plannerService: KeywordPlannerService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  async planForCategory(params: {
    category: ProductCategory;
    allocatedCount: number;
    batchId?: string;
  }): Promise<CategoryPlanOutput | null> {
    const { category, allocatedCount, batchId } = params;

    const config = this.dynamicConfigService.keywordResearch;
    const overFetchMultiplier =
      config?.overFetchMultiplier ?? DEFAULTS.overFetchMultiplier;
    const topProductSampleSize =
      config?.topProductSampleSize ?? DEFAULTS.topProductSampleSize;
    const yieldHistoryWeeks =
      config?.yieldHistoryWeeks ?? DEFAULTS.yieldHistoryWeeks;
    const cooldownDays = config?.cooldownDays ?? DEFAULTS.cooldownDays;

    const searchConfig = this.categoryConfigService.getSearchConfig(
      category.slug,
    );
    if (!searchConfig) {
      this.logger.warn("Skipping category — no search config", {
        batchId,
        categorySlug: category.slug,
      });
      return null;
    }

    const requestCount = Math.ceil(allocatedCount * overFetchMultiplier);

    const [stats, cooldownMap, topProducts] = await Promise.all([
      this.statsService.getStats(category.id, yieldHistoryWeeks),
      this.cooldownService.getActiveCooldown(category.id, cooldownDays),
      this.topProductSampler.sample(category.id, topProductSampleSize),
    ]);

    const categoryConfig = this.categoryConfigService.getConfig(category.slug);
    const searchedKeywords: SearchedKeywordSummary[] = stats.map((stat) => {
      const cooldown = cooldownMap.get(stat.keyword.toLowerCase());
      return {
        keyword: stat.keyword,
        weeksSinceLastSearch: cooldown?.weeksSinceLastSearch ?? Infinity,
        threadsDiscovered: stat.discovered,
        threadsProcessed: stat.processed,
        threadsRejected: stat.rejected,
      };
    });

    const plannerResult = await this.plannerService.plan({
      category: {
        name: category.name,
        aliases: category.aliases ?? [],
        useCases: (categoryConfig?.useCases ?? []).map(
          (useCase) => useCase.label,
        ),
        featureLabels: (categoryConfig?.features ?? []).map(
          (feature) => feature.label,
        ),
      },
      baseKeywords: searchConfig.keywords,
      year: new Date().getFullYear(),
      topProducts,
      searchedKeywords,
      requestCount,
      batchId,
      categoryId: category.id,
      categorySlug: category.slug,
    });

    const survivors = plannerResult.keywords.filter(
      (keyword) => !cooldownMap.has(keyword.toLowerCase()),
    );
    const droppedByCooldown = plannerResult.keywords.filter((keyword) =>
      cooldownMap.has(keyword.toLowerCase()),
    );
    const sliced = survivors.slice(0, allocatedCount);

    return {
      plannedKeywords: plannerResult.keywords,
      survivors,
      sliced,
      droppedByCooldown,
      plannerCost: plannerResult.cost,
      plannerLatencyMs: plannerResult.latencyMs,
      plannerModel: plannerResult.model,
      inputs: {
        baseKeywords: searchConfig.keywords,
        topProducts,
        searchedKeywords,
        requestCount,
        allocatedCount,
        overFetchMultiplier,
        topProductSampleSize,
        yieldHistoryWeeks,
        cooldownDays,
      },
      cooldown: Array.from(cooldownMap.values()),
      stats,
    };
  }
}
