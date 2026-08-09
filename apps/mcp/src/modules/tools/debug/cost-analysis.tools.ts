import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { UserCommentRepository } from "@ebike-backend/database";
import { LokiTraceReader } from "@ebike-backend/debug";
import { sumBy, uniq } from "lodash";

@Injectable()
export class CostAnalysisTools {
  constructor(
    private readonly lokiReader: LokiTraceReader,
    private readonly commentRepo: UserCommentRepository,
  ) {}

  @Tool({
    name: "get_cost_analysis",
    description:
      "Get cost breakdown for one or more threads. Shows per-step, per-model, or per-costLabel costs. Compare multiple threads side by side.",
    parameters: z.object({
      threadIds: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe("Thread UUIDs to analyze (max 5)"),
      groupBy: z
        .enum(["step", "model", "costLabel", "batchId"])
        .optional()
        .describe("How to group costs (default: step)"),
    }),
  })
  async getCostAnalysis(args: {
    threadIds: string[];
    groupBy?: "step" | "model" | "costLabel" | "batchId";
  }): Promise<string> {
    const groupBy = args.groupBy ?? "step";
    const rows = await this.lokiReader.getCostAggregation(
      args.threadIds,
      groupBy,
    );

    if (rows.length === 0) {
      return "No traces found for the provided thread IDs.";
    }

    const isComparison = args.threadIds.length > 1;
    const threadLabels = new Map(
      args.threadIds.map((id, i) => [
        id,
        `Thread ${String.fromCharCode(65 + i)}`,
      ]),
    );

    // Collect all unique group keys
    const allKeys = uniq(rows.map((r) => r.groupKey));

    // Group by key for comparison
    const byKey: Record<
      string,
      Record<
        string,
        { calls: number; cost: number; tokens: number; cachedTokens: number }
      >
    > = {};
    for (const row of rows) {
      if (!byKey[row.groupKey]) byKey[row.groupKey] = {};
      byKey[row.groupKey][row.threadId] = {
        calls: row.calls,
        cost: row.cost,
        tokens: row.tokens,
        cachedTokens: row.cachedTokens,
      };
    }

    const L: string[] = [];
    L.push(`# Cost Analysis (grouped by ${groupBy})`);
    L.push("");

    if (isComparison) {
      // Thread legend
      L.push("## Threads");
      for (const [id, label] of threadLabels) {
        L.push(`- ${label}: \`${id}\``);
      }
      L.push("");

      // Build comparison table
      const headerCols = [
        "| " + groupBy.charAt(0).toUpperCase() + groupBy.slice(1),
      ];
      for (const [, label] of threadLabels) {
        headerCols.push(`${label} Cost`);
        headerCols.push(`${label} Calls`);
      }
      if (args.threadIds.length === 2) {
        headerCols.push("Delta");
      }
      headerCols.push("");
      L.push(headerCols.join(" | "));
      L.push(
        "|" +
          headerCols
            .slice(1)
            .map(() => "---")
            .join("|") +
          "|",
      );

      // Rows sorted by total cost across all threads
      allKeys
        .sort((a, b) => {
          const totalA = sumBy(Object.values(byKey[a] ?? {}), "cost");
          const totalB = sumBy(Object.values(byKey[b] ?? {}), "cost");
          return totalB - totalA;
        })
        .forEach((key) => {
          const cols = [`| ${key}`];
          const threadCosts: number[] = [];
          for (const [id] of threadLabels) {
            const data = byKey[key]?.[id];
            cols.push(data ? `$${data.cost.toFixed(4)}` : "-");
            cols.push(data ? `${data.calls}` : "-");
            threadCosts.push(data?.cost ?? 0);
          }
          if (args.threadIds.length === 2 && threadCosts[0] > 0) {
            const delta =
              ((threadCosts[1] - threadCosts[0]) / threadCosts[0]) * 100;
            cols.push(`${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`);
          } else if (args.threadIds.length === 2) {
            cols.push("-");
          }
          cols.push("");
          L.push(cols.join(" | "));
        });

      // Totals row
      const totalCols = ["| **Total**"];
      const threadTotals: number[] = [];
      for (const [id] of threadLabels) {
        const threadRows = rows.filter((r) => r.threadId === id);
        const totalCost = sumBy(threadRows, "cost");
        const totalCalls = sumBy(threadRows, "calls");
        totalCols.push(`**$${totalCost.toFixed(4)}**`);
        totalCols.push(`**${totalCalls}**`);
        threadTotals.push(totalCost);
      }
      if (args.threadIds.length === 2 && threadTotals[0] > 0) {
        const delta =
          ((threadTotals[1] - threadTotals[0]) / threadTotals[0]) * 100;
        totalCols.push(`**${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%**`);
      } else if (args.threadIds.length === 2) {
        totalCols.push("-");
      }
      totalCols.push("");
      L.push(totalCols.join(" | "));
    } else {
      // Single thread table
      L.push(`Thread: \`${args.threadIds[0]}\``);
      L.push("");
      L.push(
        `| ${groupBy.charAt(0).toUpperCase() + groupBy.slice(1)} | Cost | Calls | Tokens | Cached | Cache Rate |`,
      );
      L.push("|---|------|-------|--------|--------|------------|");

      let totalCost = 0;
      let totalCalls = 0;
      let totalTokens = 0;
      let totalCached = 0;

      allKeys
        .sort((a, b) => {
          const dataA = byKey[a]?.[args.threadIds[0]];
          const dataB = byKey[b]?.[args.threadIds[0]];
          return (dataB?.cost ?? 0) - (dataA?.cost ?? 0);
        })
        .forEach((key) => {
          const data = byKey[key]?.[args.threadIds[0]];
          if (!data) return;
          const cacheRate =
            data.tokens > 0
              ? `${((data.cachedTokens / data.tokens) * 100).toFixed(0)}%`
              : "-";
          L.push(
            `| ${key} | $${data.cost.toFixed(4)} | ${data.calls} | ${data.tokens} | ${data.cachedTokens} | ${cacheRate} |`,
          );
          totalCost += data.cost;
          totalCalls += data.calls;
          totalTokens += data.tokens;
          totalCached += data.cachedTokens;
        });

      const totalCacheRate =
        totalTokens > 0
          ? `${((totalCached / totalTokens) * 100).toFixed(0)}%`
          : "-";
      L.push(
        `| **Total** | **$${totalCost.toFixed(4)}** | **${totalCalls}** | **${totalTokens}** | **${totalCached}** | **${totalCacheRate}** |`,
      );
    }

    return L.join("\n");
  }

  @Tool({
    name: "get_top_cost_comments",
    description:
      "Find the most expensive comments by total processing cost. Useful for identifying cost outliers.",
    parameters: z.object({
      threadId: z
        .string()
        .optional()
        .describe(
          "Filter by thread UUID (optional — searches all threads if omitted)",
        ),
      limit: z.number().optional().describe("Max results (default 10, max 50)"),
      stepFilter: z
        .array(z.string())
        .optional()
        .describe(
          'Only count costs from specific steps (e.g. ["planning", "extraction"])',
        ),
    }),
  })
  async getTopCostComments(args: {
    threadId?: string;
    limit?: number;
    stepFilter?: string[];
  }): Promise<string> {
    const limit = Math.min(args.limit ?? 10, 50);
    const results = await this.lokiReader.findTopCostComments(
      limit,
      args.threadId,
      args.stepFilter,
    );

    if (results.length === 0) {
      return "No traces found.";
    }

    // Look up external IDs for the comments
    const commentIds = results.map((r) => r.commentId);
    const comments = await this.commentRepo.find({
      where: commentIds.map((id) => ({ id })),
      select: ["id", "externalId", "status"],
    });
    const commentMap = new Map(comments.map((c) => [c.id, c]));

    const L: string[] = [];
    L.push(`# Top ${results.length} Most Expensive Comments`);
    if (args.threadId) L.push(`Thread: \`${args.threadId}\``);
    if (args.stepFilter?.length)
      L.push(`Step filter: ${args.stepFilter.join(", ")}`);
    L.push("");
    L.push(
      "| # | ExternalId | Status | Cost | Calls | Tokens | Cached | Steps | Models |",
    );
    L.push(
      "|---|-----------|--------|------|-------|--------|--------|-------|--------|",
    );

    results.forEach((r, i) => {
      const comment = commentMap.get(r.commentId);
      const externalId = comment?.externalId ?? r.commentId.slice(0, 8);
      const status = comment?.status ?? "-";
      const cacheInfo = r.cachedTokens > 0 ? `${r.cachedTokens}` : "-";
      L.push(
        `| ${i + 1} | ${externalId} | ${status} | $${r.cost.toFixed(4)} | ${r.calls} | ${r.tokens} | ${cacheInfo} | ${r.steps} | ${r.models} |`,
      );
    });

    const totalCost = sumBy(results, "cost");
    L.push("");
    L.push(
      `Total cost for top ${results.length}: **$${totalCost.toFixed(4)}**`,
    );

    return L.join("\n");
  }
}
