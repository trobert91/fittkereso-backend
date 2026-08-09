import {
  Body,
  Controller,
  Post,
  SerializeOptions,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import { UserRole } from "@ebike-backend/database";
import {
  CategoryAllocation,
  KeywordBudgetAllocator,
  KeywordCategoryPlannerService,
  KeywordResearchOrchestrator,
  type CategoryPlanOutput,
  type KeywordResearchRunOptions,
  type KeywordResearchRunResult,
} from "@ebike-backend/thread-search";
import { CustomLogger } from "@ebike-backend/logger";

@Controller("admin-keyword-research")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminKeywordResearchController {
  private readonly logger = new CustomLogger(
    AdminKeywordResearchController.name,
  );

  constructor(
    private readonly orchestrator: KeywordResearchOrchestrator,
    private readonly budgetAllocator: KeywordBudgetAllocator,
    private readonly categoryPlanner: KeywordCategoryPlannerService,
  ) {}

  /**
   * Manually trigger a keyword-research run outside the weekly cron.
   * Optional body lets the caller scope to specific categories or override
   * the global keyword budget for this run.
   */
  @Post("trigger")
  @SerializeOptions({ strategy: "exposeAll" })
  async trigger(
    @Body() body?: KeywordResearchRunOptions,
  ): Promise<KeywordResearchRunResult> {
    return this.orchestrator.execute(body ?? {});
  }

  /**
   * Dry-run preview of the planning phase: returns what keywords the weekly
   * scheduler would generate per category, plus the planner inputs (stats,
   * cooldown, top products) and cost. Does NOT execute Reddit searches and
   * does NOT mark keywords as searched. Reuses the same allocator + planner
   * the scheduler uses so the keyword list matches what production would do
   * up to the cooldown filter.
   */
  @Post("debug")
  @SerializeOptions({ strategy: "exposeAll" })
  async debug(
    @Body() body: KeywordResearchDebugDto = {},
  ): Promise<KeywordResearchDebugResult> {
    const startTime = Date.now();

    const allocations = await this.budgetAllocator.allocate({
      ...(body.categorySlugs && { categorySlugs: body.categorySlugs }),
      ...(body.overrideTotal !== undefined && {
        overrideTotal: body.overrideTotal,
      }),
    });

    const totalKeywordsBudget = allocations.reduce(
      (sum, allocation) => sum + allocation.keywordCount,
      0,
    );

    const categoryResults: KeywordResearchDebugCategoryResult[] = [];
    for (const allocation of allocations) {
      const result = await this.runCategoryDebug(allocation);
      categoryResults.push(result);
    }

    return {
      totalKeywordsBudget,
      categoriesEligible: allocations.length,
      categoriesProcessed: categoryResults.filter((r) => r.error === null)
        .length,
      categoriesFailed: categoryResults.filter((r) => r.error !== null).length,
      totalPlannerCost: categoryResults.reduce(
        (sum, row) => sum + (row.plan?.plannerCost ?? 0),
        0,
      ),
      durationMs: Date.now() - startTime,
      categories: categoryResults,
    };
  }

  private async runCategoryDebug(
    allocation: CategoryAllocation,
  ): Promise<KeywordResearchDebugCategoryResult> {
    const { category, keywordCount: allocatedCount } = allocation;
    const categoryStart = Date.now();

    try {
      const plan = await this.categoryPlanner.planForCategory({
        category,
        allocatedCount,
      });

      if (!plan) {
        return {
          categorySlug: category.slug,
          categoryName: category.name,
          categoryId: category.id,
          allocation: this.mapAllocation(allocation),
          plan: null,
          skipped: true,
          skippedReason:
            "No search config (libs/config/.../search.json missing).",
          error: null,
          durationMs: Date.now() - categoryStart,
        };
      }

      return {
        categorySlug: category.slug,
        categoryName: category.name,
        categoryId: category.id,
        allocation: this.mapAllocation(allocation),
        plan: this.mapPlan(plan),
        skipped: false,
        skippedReason: null,
        error: null,
        durationMs: Date.now() - categoryStart,
      };
    } catch (error: unknown) {
      this.logger.warn("Debug planForCategory failed", {
        categorySlug: category.slug,
        error,
      });
      return {
        categorySlug: category.slug,
        categoryName: category.name,
        categoryId: category.id,
        allocation: this.mapAllocation(allocation),
        plan: null,
        skipped: false,
        skippedReason: null,
        error: error instanceof Error ? error.message : "Planner failed.",
        durationMs: Date.now() - categoryStart,
      };
    }
  }

  private mapAllocation(
    allocation: CategoryAllocation,
  ): KeywordResearchDebugAllocation {
    return {
      searchPriority: allocation.searchPriority,
      backlog: allocation.backlog,
      normalizedPriority: allocation.normalizedPriority,
      deficitScore: allocation.deficitScore,
      score: allocation.score,
      keywordCount: allocation.keywordCount,
    };
  }

  private mapPlan(plan: CategoryPlanOutput): KeywordResearchDebugPlan {
    return {
      plannedKeywords: plan.plannedKeywords,
      survivors: plan.survivors,
      sliced: plan.sliced,
      droppedByCooldown: plan.droppedByCooldown,
      plannerCost: plan.plannerCost,
      plannerLatencyMs: plan.plannerLatencyMs,
      plannerModel: plan.plannerModel,
      requestCount: plan.inputs.requestCount,
      allocatedCount: plan.inputs.allocatedCount,
      baseKeywords: plan.inputs.baseKeywords,
      topProducts: plan.inputs.topProducts,
      searchedKeywords: plan.inputs.searchedKeywords.map((row) => ({
        keyword: row.keyword,
        weeksSinceLastSearch: Number.isFinite(row.weeksSinceLastSearch)
          ? row.weeksSinceLastSearch
          : null,
        threadsDiscovered: row.threadsDiscovered,
        threadsProcessed: row.threadsProcessed,
        threadsRejected: row.threadsRejected,
      })),
      cooldown: plan.cooldown.map((entry) => ({
        keyword: entry.keyword,
        weeksSinceLastSearch: entry.weeksSinceLastSearch,
      })),
    };
  }
}

export interface KeywordResearchDebugDto {
  categorySlugs?: string[];
  overrideTotal?: number;
}

export interface KeywordResearchDebugAllocation {
  searchPriority: number;
  backlog: number;
  normalizedPriority: number;
  deficitScore: number;
  score: number;
  keywordCount: number;
}

export interface KeywordResearchDebugSearchedKeyword {
  keyword: string;
  /** null when the keyword has never been searched (Infinity in the source). */
  weeksSinceLastSearch: number | null;
  threadsDiscovered: number;
  threadsProcessed: number;
  threadsRejected: number;
}

export interface KeywordResearchDebugCooldown {
  keyword: string;
  weeksSinceLastSearch: number;
}

export interface KeywordResearchDebugPlan {
  plannedKeywords: string[];
  survivors: string[];
  sliced: string[];
  droppedByCooldown: string[];
  plannerCost: number;
  plannerLatencyMs: number;
  plannerModel: string;
  requestCount: number;
  allocatedCount: number;
  baseKeywords: string[];
  topProducts: string[];
  searchedKeywords: KeywordResearchDebugSearchedKeyword[];
  cooldown: KeywordResearchDebugCooldown[];
}

export interface KeywordResearchDebugCategoryResult {
  categorySlug: string;
  categoryName: string;
  categoryId: string;
  allocation: KeywordResearchDebugAllocation;
  plan: KeywordResearchDebugPlan | null;
  skipped: boolean;
  skippedReason: string | null;
  error: string | null;
  durationMs: number;
}

export interface KeywordResearchDebugResult {
  totalKeywordsBudget: number;
  categoriesEligible: number;
  categoriesProcessed: number;
  categoriesFailed: number;
  totalPlannerCost: number;
  durationMs: number;
  categories: KeywordResearchDebugCategoryResult[];
}
