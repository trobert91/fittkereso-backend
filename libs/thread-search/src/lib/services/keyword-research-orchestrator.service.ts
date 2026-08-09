import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { ThreadPlatform } from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { TraceLoggerService } from "@ebike-backend/debug";
import { CustomLogger } from "@ebike-backend/logger";
import { ThreadSearchTaskCreatorService } from "@ebike-backend/task";
import {
  KeywordBudgetAllocator,
  type CategoryAllocation,
} from "./keyword-budget-allocator.service";
import { KeywordCooldownService } from "./keyword-cooldown.service";
import { KeywordCategoryPlannerService } from "./keyword-category-planner.service";

export interface KeywordResearchRunOptions {
  categorySlugs?: string[];
  overrideTotal?: number;
}

export interface KeywordResearchRunResult {
  batchId: string;
  totalKeywordsBudget: number;
  categoriesProcessed: number;
  categoriesFailed: number;
  keywordsEnqueued: number;
  totalPlannerCost: number;
  durationMs: number;
}

/**
 * Top-level orchestrator for the weekly keyword-research run.
 *
 * Flow:
 *  1. Allocate the global budget across enabled categories.
 *  2. Emit a top-level scheduling trace.
 *  3. For each category, plan keywords via LLM, filter cooldown set, slice
 *     to the allocation, persist one ThreadSearchTask per surviving keyword,
 *     and mark each in cooldown immediately so the next weekly run does not
 *     replan them while they are still in the backlog.
 *  4. Each category is isolated — one failure does not block siblings.
 */
@Injectable()
export class KeywordResearchOrchestrator {
  private readonly logger = new CustomLogger(KeywordResearchOrchestrator.name);

  constructor(
    private readonly budgetAllocator: KeywordBudgetAllocator,
    private readonly categoryPlanner: KeywordCategoryPlannerService,
    private readonly cooldownService: KeywordCooldownService,
    private readonly threadSearchTaskCreator: ThreadSearchTaskCreatorService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly traceLogger: TraceLoggerService,
  ) {}

  async execute(
    options: KeywordResearchRunOptions = {},
  ): Promise<KeywordResearchRunResult> {
    const batchId = uuidv4();
    const startTime = Date.now();

    const allocations = await this.budgetAllocator.allocate(options);
    const totalKeywordsBudget = allocations.reduce(
      (sum, allocation) => sum + allocation.keywordCount,
      0,
    );

    this.logger.log("Run starting", {
      batchId,
      totalKeywordsBudget,
      categoriesEligible: allocations.length,
      overrideCategorySlugs: options.categorySlugs ?? null,
    });

    this.logger.log("Allocation computed", {
      batchId,
      allocations: allocations.map((row) => ({
        slug: row.category.slug,
        searchPriority: row.searchPriority,
        backlog: row.backlog,
        score: row.score,
        keywordCount: row.keywordCount,
      })),
    });

    this.emitRunTrace(batchId, totalKeywordsBudget, allocations);

    let categoriesProcessed = 0;
    let categoriesFailed = 0;
    let keywordsEnqueuedTotal = 0;
    let totalPlannerCost = 0;

    for (const allocation of allocations) {
      try {
        const categoryResult = await this.processCategory({
          batchId,
          allocation,
        });
        categoriesProcessed++;
        keywordsEnqueuedTotal += categoryResult.keywordsEnqueued;
        totalPlannerCost += categoryResult.plannerCost;
      } catch (error: unknown) {
        categoriesFailed++;
        this.logger.warn(
          "Category processing failed, continuing with siblings",
          {
            batchId,
            categorySlug: allocation.category.slug,
            error,
          },
        );
      }
    }

    const durationMs = Date.now() - startTime;
    const result: KeywordResearchRunResult = {
      batchId,
      totalKeywordsBudget,
      categoriesProcessed,
      categoriesFailed,
      keywordsEnqueued: keywordsEnqueuedTotal,
      totalPlannerCost,
      durationMs,
    };

    this.logger.log("Run finished", result);

    return result;
  }

  private async processCategory(params: {
    batchId: string;
    allocation: CategoryAllocation;
  }): Promise<{
    keywordsEnqueued: number;
    plannerCost: number;
  }> {
    const { batchId, allocation } = params;
    const { category, keywordCount: allocatedCount } = allocation;
    const categoryStartTime = Date.now();

    this.logger.log("Processing category", {
      batchId,
      categorySlug: category.slug,
      categoryId: category.id,
      allocatedCount,
    });

    const plan = await this.categoryPlanner.planForCategory({
      category,
      allocatedCount,
      batchId,
    });

    if (!plan) {
      return { keywordsEnqueued: 0, plannerCost: 0 };
    }

    const {
      plannedKeywords,
      sliced,
      droppedByCooldown,
      plannerCost,
      plannerLatencyMs,
      plannerModel,
      inputs: { requestCount },
    } = plan;

    const shortfallPercent =
      allocatedCount > 0
        ? ((allocatedCount - sliced.length) / allocatedCount) * 100
        : 0;
    if (shortfallPercent > 30) {
      this.logger.warn("Short of allocation after cooldown filter", {
        batchId,
        categorySlug: category.slug,
        allocatedCount,
        survivors: sliced.length,
        shortfallPercent,
      });
    }

    const searchConfig = this.categoryConfigService.getSearchConfig(
      category.slug,
    );
    if (!searchConfig?.platforms.reddit) {
      this.logger.warn("Skipping category — no reddit search config", {
        batchId,
        categorySlug: category.slug,
      });
      return { keywordsEnqueued: 0, plannerCost };
    }

    let keywordsEnqueued = 0;
    const enqueueFailures: Array<{ keyword: string; error: unknown }> = [];

    for (const keyword of sliced) {
      try {
        await this.threadSearchTaskCreator.create({
          keyword,
          platform: ThreadPlatform.Reddit,
          categorySlug: category.slug,
        });
        await this.cooldownService.markSearched({
          categoryId: category.id,
          categorySlug: category.slug,
          keyword,
          platform: ThreadPlatform.Reddit,
        });
        keywordsEnqueued++;
      } catch (error: unknown) {
        enqueueFailures.push({ keyword, error });
        this.logger.warn("Failed to enqueue ThreadSearchTask", {
          batchId,
          categorySlug: category.slug,
          keyword,
          error,
        });
      }
    }

    const durationMs = Date.now() - categoryStartTime;

    this.emitCategoryTrace({
      batchId,
      categorySlug: category.slug,
      categoryId: category.id,
      plannerModel,
      plannerLatencyMs,
      plannerCost,
      allocatedCount,
      requestCount,
      plannerReturned: plannedKeywords.length,
      keywordsDroppedByCooldown: droppedByCooldown.length,
      keywordsEnqueued,
      enqueueFailures: enqueueFailures.length,
      durationMs,
    });

    this.logger.log("Category complete", {
      batchId,
      categorySlug: category.slug,
      keywordsEnqueued,
      enqueueFailures: enqueueFailures.length,
      plannerCost,
      durationMs,
    });

    return { keywordsEnqueued, plannerCost };
  }

  private emitRunTrace(
    batchId: string,
    totalKeywordsBudget: number,
    allocations: CategoryAllocation[],
  ): void {
    this.traceLogger.writeTrace({
      step: "keyword-research-run",
      batchId,
      data: {
        totalKeywordsBudget,
        allocations: allocations.map((row) => ({
          categorySlug: row.category.slug,
          categoryId: row.category.id,
          searchPriority: row.searchPriority,
          backlog: row.backlog,
          normalizedPriority: row.normalizedPriority,
          deficitScore: row.deficitScore,
          score: row.score,
          keywordCount: row.keywordCount,
        })),
      },
    });
  }

  private emitCategoryTrace(payload: {
    batchId: string;
    categorySlug: string;
    categoryId: string;
    plannerModel: string;
    plannerLatencyMs: number;
    plannerCost: number;
    allocatedCount: number;
    requestCount: number;
    plannerReturned: number;
    keywordsDroppedByCooldown: number;
    keywordsEnqueued: number;
    enqueueFailures: number;
    durationMs: number;
  }): void {
    const { batchId, ...data } = payload;
    this.traceLogger.writeTrace({
      step: "keyword-research-category",
      batchId,
      data,
    });
  }
}
