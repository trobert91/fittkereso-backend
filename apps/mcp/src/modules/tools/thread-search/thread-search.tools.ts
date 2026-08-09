import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import {
  ProductCategory,
  ThreadSearchKeywordRepository,
  ProductCategoryRepository,
  ThreadSearchKeyword,
} from "@ebike-backend/database";
import { LokiTraceReader } from "@ebike-backend/debug";
import { KeywordStatsService } from "@ebike-backend/thread-search";
import { nameOf } from "@ebike-backend/utils";

interface KeywordRow {
  keyword: string;
  platform: string;
  lastSearchedAt: Date;
  discovered: number;
  processed: number;
  rejected: number;
  weeksSinceLastSearch: number;
}

@Injectable()
export class ThreadSearchTools {
  constructor(
    private readonly threadSearchKeywordRepository: ThreadSearchKeywordRepository,
    private readonly productCategoryRepository: ProductCategoryRepository,
    private readonly keywordStatsService: KeywordStatsService,
    private readonly lokiReader: LokiTraceReader,
  ) {}

  // ─── search_thread_search_keywords ────────────────────────────────────────

  @Tool({
    name: "search_thread_search_keywords",
    description:
      "Search/filter ThreadSearchKeyword cooldown records, joined with on-the-fly stats (discovered, processed, rejected) derived from threads.keywords. EMA fields are gone — stats are derived from Thread.keywords now.",
    parameters: z.object({
      categorySlug: z.string().optional().describe("Filter by category slug"),
      platform: z
        .enum(["reddit", "youtube"])
        .optional()
        .describe("Filter by platform"),
      keyword: z
        .string()
        .optional()
        .describe("Text search on keyword field (case-insensitive)"),
      sortBy: z
        .enum(["lastSearchedAt", "keyword"])
        .optional()
        .describe("Sort field (default: lastSearchedAt DESC)"),
      limit: z.number().optional().describe("Max results (default 50)"),
      yieldHistoryWeeks: z
        .number()
        .optional()
        .describe("Window (weeks) for derived stats. Default: 8"),
    }),
    annotations: { readOnlyHint: true },
  })
  async searchKeywords(args: {
    categorySlug?: string;
    platform?: string;
    keyword?: string;
    sortBy?: "lastSearchedAt" | "keyword";
    limit?: number;
    yieldHistoryWeeks?: number;
  }): Promise<string> {
    const limit = Math.min(args.limit ?? 50, 100);
    const yieldHistoryWeeks = args.yieldHistoryWeeks ?? 8;

    const queryBuilder = this.threadSearchKeywordRepository.repo
      .createQueryBuilder("kw")
      .leftJoinAndSelect(`kw.${nameOf<ThreadSearchKeyword>("category")}`, "cat")
      .take(limit);

    if (args.categorySlug) {
      queryBuilder.andWhere(`cat.${nameOf<ProductCategory>("slug")} = :slug`, {
        slug: args.categorySlug,
      });
    }
    if (args.platform) {
      queryBuilder.andWhere(
        `kw.${nameOf<ThreadSearchKeyword>("platform")} = :platform`,
        { platform: args.platform },
      );
    }
    if (args.keyword) {
      queryBuilder.andWhere(
        `kw.${nameOf<ThreadSearchKeyword>("keyword")} ILIKE :keyword`,
        { keyword: `%${args.keyword}%` },
      );
    }

    const sortField = args.sortBy ?? "lastSearchedAt";
    queryBuilder.orderBy(`kw.${sortField}`, "DESC", "NULLS LAST");

    const cooldownRecords = await queryBuilder.getMany();

    if (cooldownRecords.length === 0) {
      return "No keywords found matching the given filters.";
    }

    // Fetch stats once per category, then join in-memory.
    const categoryIds = Array.from(
      new Set(cooldownRecords.map((kw) => kw.categoryId)),
    );
    const statsByCategoryKeyword = new Map<
      string,
      { discovered: number; processed: number; rejected: number }
    >();
    for (const categoryId of categoryIds) {
      const stats = await this.keywordStatsService.getStats(
        categoryId,
        yieldHistoryWeeks,
      );
      for (const stat of stats) {
        statsByCategoryKeyword.set(
          `${categoryId}|${stat.keyword.toLowerCase()}`,
          {
            discovered: stat.discovered,
            processed: stat.processed,
            rejected: stat.rejected,
          },
        );
      }
    }

    const now = Date.now();
    const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
    const rows: Array<KeywordRow & { categoryName: string }> =
      cooldownRecords.map((kw) => {
        const stat = statsByCategoryKeyword.get(
          `${kw.categoryId}|${kw.keyword.toLowerCase()}`,
        ) ?? { discovered: 0, processed: 0, rejected: 0 };
        return {
          categoryName: kw.category?.name ?? kw.categoryId,
          keyword: kw.keyword,
          platform: kw.platform,
          lastSearchedAt: kw.lastSearchedAt,
          weeksSinceLastSearch:
            (now - kw.lastSearchedAt.getTime()) / MS_PER_WEEK,
          discovered: stat.discovered,
          processed: stat.processed,
          rejected: stat.rejected,
        };
      });

    const L: string[] = [];
    L.push(
      `# Thread Search Keywords (${rows.length} results, stats over ${yieldHistoryWeeks}-week window)`,
    );
    L.push("");
    L.push(
      "| Category | Keyword | Platform | Last Searched | Weeks Ago | Discovered | Processed | Rejected |",
    );
    L.push(
      "|----------|---------|----------|---------------|-----------|------------|-----------|----------|",
    );

    for (const row of rows) {
      L.push(
        `| ${row.categoryName} | ${row.keyword} | ${row.platform} | ${row.lastSearchedAt.toISOString().slice(0, 16)} | ${row.weeksSinceLastSearch.toFixed(1)} | ${row.discovered} | ${row.processed} | ${row.rejected} |`,
      );
    }

    return L.join("\n");
  }

  // ─── get_search_stats_by_category ─────────────────────────────────────────

  @Tool({
    name: "get_search_stats_by_category",
    description:
      "Aggregated keyword stats per category, computed on-the-fly from threads.keywords. Shows top performers (high processed-yield) and worst performers (high rejection rate) per category.",
    parameters: z.object({
      categorySlug: z
        .string()
        .optional()
        .describe(
          "Filter to specific category (all search-enabled if omitted)",
        ),
      yieldHistoryWeeks: z
        .number()
        .optional()
        .describe("Window (weeks) for stats. Default: 8"),
    }),
    annotations: { readOnlyHint: true },
  })
  async getSearchStatsByCategory(args: {
    categorySlug?: string;
    yieldHistoryWeeks?: number;
  }): Promise<string> {
    const yieldHistoryWeeks = args.yieldHistoryWeeks ?? 8;

    const categories = await this.productCategoryRepository.repo.find({
      where: args.categorySlug
        ? { slug: args.categorySlug }
        : { searchEnabled: true },
      order: { searchPriority: "DESC" },
    });

    if (categories.length === 0) {
      return "No matching categories found.";
    }

    const L: string[] = [];
    L.push(`# Search Stats by Category (${yieldHistoryWeeks}-week window)`);

    for (const category of categories) {
      const stats = await this.keywordStatsService.getStats(
        category.id,
        yieldHistoryWeeks,
      );

      const totalDiscovered = stats.reduce((sum, s) => sum + s.discovered, 0);
      const totalProcessed = stats.reduce((sum, s) => sum + s.processed, 0);
      const totalRejected = stats.reduce((sum, s) => sum + s.rejected, 0);
      const usefulYieldRate =
        totalDiscovered > 0 ? (totalProcessed / totalDiscovered) * 100 : 0;

      const cooldownCount = await this.threadSearchKeywordRepository.repo.count(
        {
          where: { categoryId: category.id },
        },
      );

      L.push("");
      L.push(`## ${category.name} (\`${category.slug}\`)`);
      L.push(
        `- **Search Priority:** ${category.searchPriority} | **Enabled:** ${category.searchEnabled ? "Yes" : "No"}`,
      );
      L.push(
        `- **Keywords in cooldown table:** ${cooldownCount} | **Keywords with stats:** ${stats.length}`,
      );
      L.push(
        `- **Discovered:** ${totalDiscovered} | **Processed:** ${totalProcessed} | **Rejected:** ${totalRejected}`,
      );
      L.push(
        `- **Useful Yield Rate:** ${usefulYieldRate.toFixed(1)}% (processed / discovered)`,
      );

      if (stats.length > 0) {
        const topByProcessed = [...stats]
          .sort((a, b) => b.processed - a.processed)
          .slice(0, 5);
        L.push("");
        L.push("**Top 5 Keywords by Processed:**");
        L.push(
          "| Keyword | Discovered | Processed | Rejected | Useful Yield |",
        );
        L.push(
          "|---------|------------|-----------|----------|--------------|",
        );
        for (const stat of topByProcessed) {
          const usefulYield =
            stat.discovered > 0
              ? ((stat.processed / stat.discovered) * 100).toFixed(1) + "%"
              : "-";
          L.push(
            `| ${stat.keyword} | ${stat.discovered} | ${stat.processed} | ${stat.rejected} | ${usefulYield} |`,
          );
        }

        const worstByRejection = [...stats]
          .filter((s) => s.discovered >= 3)
          .sort(
            (a, b) =>
              b.rejected / Math.max(1, b.discovered) -
              a.rejected / Math.max(1, a.discovered),
          )
          .slice(0, 5);
        if (worstByRejection.length > 0) {
          L.push("");
          L.push("**Bottom 5 Keywords by Rejection Rate (≥3 discoveries):**");
          L.push("| Keyword | Discovered | Rejected | Rejection Rate |");
          L.push("|---------|------------|----------|----------------|");
          for (const stat of worstByRejection) {
            const rejectionRate =
              stat.discovered > 0
                ? ((stat.rejected / stat.discovered) * 100).toFixed(1) + "%"
                : "-";
            L.push(
              `| ${stat.keyword} | ${stat.discovered} | ${stat.rejected} | ${rejectionRate} |`,
            );
          }
        }
      }
    }

    return L.join("\n");
  }

  // ─── get_keyword_research_run_trace (was get_thread_search_cycle_trace) ───

  @Tool({
    name: "get_thread_search_cycle_trace",
    description:
      "Inspect a keyword-research run trace: budget allocation across categories, per-category scores (priority + deficit), keyword counts.",
    parameters: z.object({
      batchId: z.string().optional().describe("Specific run/batch ID"),
    }),
    annotations: { readOnlyHint: true },
  })
  async getCycleTrace(args: { batchId?: string }): Promise<string> {
    const traces = await this.lokiReader.findByStep("keyword-research-run", {
      batchId: args.batchId,
      limit: 1,
      order: "DESC",
    });

    if (traces.length === 0) {
      return "No keyword research run trace found.";
    }

    const trace = traces[0];
    const data = trace.data as {
      totalKeywordsBudget?: number;
      allocations?: Array<{
        categorySlug: string;
        searchPriority: number;
        backlog: number;
        normalizedPriority: number;
        deficitScore: number;
        score: number;
        keywordCount: number;
      }>;
    };

    const L: string[] = [];
    L.push("# Keyword Research Run");
    L.push(`- **Batch ID:** ${trace.batchId ?? "-"}`);
    L.push(`- **Timestamp:** ${trace.createdAt.toISOString()}`);
    L.push(`- **Total Keywords Budget:** ${data.totalKeywordsBudget ?? "-"}`);
    L.push("");

    if (data.allocations?.length) {
      L.push("## Category Allocations");
      L.push(
        "| Category | Priority | Backlog (SELECTED) | Normalized Priority | Deficit Score | Total Score | Keywords |",
      );
      L.push(
        "|----------|----------|--------------------|----|----|-----|----------|",
      );
      for (const allocation of data.allocations) {
        L.push(
          `| ${allocation.categorySlug} | ${allocation.searchPriority} | ${allocation.backlog} | ${allocation.normalizedPriority.toFixed(3)} | ${allocation.deficitScore.toFixed(3)} | ${allocation.score.toFixed(3)} | ${allocation.keywordCount} |`,
        );
      }
    }

    return L.join("\n");
  }

  // ─── get_thread_search_execution_traces ───────────────────────────────────

  @Tool({
    name: "get_thread_search_execution_traces",
    description:
      "Inspect per-search execution traces: results breakdown (discovered/duplicates/rejected), relevance distributions.",
    parameters: z.object({
      batchId: z.string().optional().describe("Filter by run batch ID"),
      categorySlug: z.string().optional().describe("Filter by category slug"),
      keyword: z
        .string()
        .optional()
        .describe("Filter by keyword (case-insensitive)"),
      platform: z
        .enum(["reddit", "youtube"])
        .optional()
        .describe("Filter by platform"),
      limit: z.number().optional().describe("Max results (default 20)"),
    }),
    annotations: { readOnlyHint: true },
  })
  async getExecutionTraces(args: {
    batchId?: string;
    categorySlug?: string;
    keyword?: string;
    platform?: string;
    limit?: number;
  }): Promise<string> {
    const limit = Math.min(args.limit ?? 20, 50);

    let allTraces = await this.lokiReader.findByStep(
      "thread-search-execution",
      {
        batchId: args.batchId,
        limit: 500,
        order: "DESC",
      },
    );

    if (args.categorySlug) {
      allTraces = allTraces.filter(
        (t) => (t.data as any).categorySlug === args.categorySlug,
      );
    }
    if (args.keyword) {
      const kwLower = args.keyword.toLowerCase();
      allTraces = allTraces.filter((t) =>
        (t.data as any).keyword?.toLowerCase()?.includes(kwLower),
      );
    }
    if (args.platform) {
      allTraces = allTraces.filter(
        (t) => (t.data as any).platform === args.platform,
      );
    }

    const traces = allTraces.slice(0, limit);

    if (traces.length === 0) {
      return "No thread search execution traces found.";
    }

    const L: string[] = [];
    L.push(`# Thread Search Execution Traces (${traces.length} results)`);

    for (const trace of traces) {
      const data = trace.data as any;
      L.push("");
      L.push("---");
      L.push(
        `### ${data.keyword} ${data.scope ? `(${data.scope})` : ""} — ${data.categorySlug}`,
      );
      L.push(
        `- **Platform:** ${data.platform} | **Sort:** ${data.sortStrategy} | **Batch:** ${trace.batchId ?? "-"}`,
      );
      L.push(`- **Time:** ${trace.createdAt.toISOString().slice(0, 19)}`);
      L.push(
        `- **Duration:** ${data.totalDurationMs}ms (API: ${data.platformApiDurationMs}ms)`,
      );
      L.push("");
      L.push("**Results:**");
      L.push(`- Total from API: ${data.totalResults}`);
      L.push(`- Duplicates: ${data.duplicates}`);
      L.push(`- Below quality gate: ${data.belowQualityGate}`);
      L.push(`- Below relevance: ${data.belowRelevance}`);
      L.push(`- **Discovered: ${data.discovered}**`);

      if (data.qualityGates) {
        L.push("");
        L.push(
          `**Quality Gates:** minScore=${data.qualityGates.minScore}, minComments=${data.qualityGates.minComments}, minRelevance=${data.qualityGates.minRelevance}`,
        );
      }

      if (data.relevanceDistribution) {
        const dist = data.relevanceDistribution;
        L.push("");
        L.push(
          `**Relevance Distribution:** min=${dist.min?.toFixed(2)}, p25=${dist.p25?.toFixed(2)}, median=${dist.median?.toFixed(2)}, p75=${dist.p75?.toFixed(2)}, max=${dist.max?.toFixed(2)}, mean=${dist.mean?.toFixed(2)}`,
        );
      }
    }

    return L.join("\n");
  }
}
