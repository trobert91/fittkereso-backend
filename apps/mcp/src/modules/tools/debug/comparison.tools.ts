import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { UserCommentRepository } from "@ebike-backend/database";
import { LokiTraceReader } from "@ebike-backend/debug";
import { sumBy, uniq } from "lodash";

interface CommentRunAggregate {
  commentId: string;
  externalId?: string;
  status: string;
  cost: number;
  tokens: number;
  cachedTokens: number;
  calls: number;
  models: Set<string>;
}

@Injectable()
export class ComparisonTools {
  constructor(
    private readonly lokiReader: LokiTraceReader,
    private readonly commentRepo: UserCommentRepository,
  ) {}

  @Tool({
    name: "compare_thread_runs",
    description:
      "Compare two processing runs of the same thread. Shows status changes, cost differences, and model selection differences. Runs are detected by finding time gaps >60s between consecutive traces.",
    parameters: z.object({
      threadId: z.string().describe("Thread UUID"),
      cutoffTimestamp: z
        .string()
        .optional()
        .describe(
          "ISO timestamp to manually split runs. If omitted, runs are auto-detected by time gaps.",
        ),
    }),
  })
  async compareThreadRuns(args: {
    threadId: string;
    cutoffTimestamp?: string;
  }): Promise<string> {
    const runs = await this.lokiReader.findRunBoundaries(args.threadId);

    if (runs.length === 0) {
      return "No traces found for this thread.";
    }

    if (runs.length < 2 && !args.cutoffTimestamp) {
      const L: string[] = [];
      L.push("# Thread Run Comparison");
      L.push("");
      L.push(
        `Only 1 run detected (${runs[0].traceCount} traces, ${runs[0].startTime.toISOString()} — ${runs[0].endTime.toISOString()}).`,
      );
      L.push("");
      L.push(
        "Reprocess the thread to create a second run for comparison, or provide a `cutoffTimestamp` to manually split.",
      );
      L.push("");
      L.push("## Detected Runs");
      runs.forEach((r) => {
        L.push(
          `- Run ${r.runIndex + 1}: ${r.startTime.toISOString()} — ${r.endTime.toISOString()} (${r.traceCount} traces)`,
        );
      });
      return L.join("\n");
    }

    // Determine run boundaries
    let run1Start: Date, run1End: Date, run2Start: Date, run2End: Date;

    if (args.cutoffTimestamp) {
      const cutoff = new Date(args.cutoffTimestamp);
      // Split: everything before cutoff = run 1, everything after = run 2
      const allStart = runs[0].startTime;
      const allEnd = runs[runs.length - 1].endTime;
      run1Start = allStart;
      run1End = cutoff;
      run2Start = cutoff;
      run2End = allEnd;
    } else {
      // Use the last two runs
      const lastTwo = runs.slice(-2);
      run1Start = lastTwo[0].startTime;
      run1End = lastTwo[0].endTime;
      run2Start = lastTwo[1].startTime;
      run2End = lastTwo[1].endTime;
    }

    // Load traces for each run
    const [run1Traces, run2Traces] = await Promise.all([
      this.lokiReader.findByThreadInTimeRange(
        args.threadId,
        run1Start,
        run1End,
      ),
      this.lokiReader.findByThreadInTimeRange(
        args.threadId,
        run2Start,
        run2End,
      ),
    ]);

    // Aggregate per comment (skip thread-level traces with null commentId)
    const run1Agg = this.aggregateByComment(run1Traces);
    const run2Agg = this.aggregateByComment(run2Traces);
    const run1BatchStats = this.computeBatchStats(run1Traces);
    const run2BatchStats = this.computeBatchStats(run2Traces);

    // Look up external IDs
    const allCommentIds = uniq([...run1Agg.keys(), ...run2Agg.keys()]);
    const comments = await this.commentRepo.find({
      where: allCommentIds.map((id) => ({ id })),
      select: ["id", "externalId"],
    });
    const externalIdMap = new Map(comments.map((c) => [c.id, c.externalId]));

    // Build output
    const L: string[] = [];
    L.push("# Thread Run Comparison");
    L.push(`Thread: \`${args.threadId}\``);
    L.push("");
    L.push("## Run Summary");
    L.push(
      `- **Run 1**: ${run1Start.toISOString()} — ${run1End.toISOString()} (${run1Traces.length} traces, ${run1Agg.size} comments)`,
    );
    L.push(
      `- **Run 2**: ${run2Start.toISOString()} — ${run2End.toISOString()} (${run2Traces.length} traces, ${run2Agg.size} comments)`,
    );
    L.push("");

    // Aggregate totals
    const run1Total = this.sumAggregates(run1Agg);
    const run2Total = this.sumAggregates(run2Agg);
    const costDelta =
      run1Total.cost > 0
        ? ((run2Total.cost - run1Total.cost) / run1Total.cost) * 100
        : 0;

    L.push("## Cost Overview");
    L.push(`| Metric | Run 1 | Run 2 | Delta |`);
    L.push("|--------|-------|-------|-------|");
    L.push(
      `| Total Cost | $${run1Total.cost.toFixed(4)} | $${run2Total.cost.toFixed(4)} | ${costDelta >= 0 ? "+" : ""}${costDelta.toFixed(1)}% |`,
    );
    L.push(
      `| Total Tokens | ${run1Total.tokens} | ${run2Total.tokens} | ${this.formatDelta(run1Total.tokens, run2Total.tokens)} |`,
    );
    L.push(
      `| Cached Tokens | ${run1Total.cachedTokens} | ${run2Total.cachedTokens} | ${this.formatDelta(run1Total.cachedTokens, run2Total.cachedTokens)} |`,
    );
    L.push(
      `| LLM Calls | ${run1Total.calls} | ${run2Total.calls} | ${this.formatDelta(run1Total.calls, run2Total.calls)} |`,
    );
    L.push("");

    // Batched pipeline stats (only shown when batched traces are present)
    if (run1BatchStats || run2BatchStats) {
      L.push("## Batched Pipeline Comparison");
      L.push("| Metric | Run 1 | Run 2 |");
      L.push("|--------|-------|-------|");
      const r1 = run1BatchStats;
      const r2 = run2BatchStats;
      L.push(
        `| Subtrees | ${r1?.subtreeCount ?? "-"} | ${r2?.subtreeCount ?? "-"} |`,
      );
      L.push(
        `| Avg PLAN nodes/subtree | ${r1 ? r1.avgPlanNodes.toFixed(1) : "-"} | ${r2 ? r2.avgPlanNodes.toFixed(1) : "-"} |`,
      );
      const r1RetryCost = r1 ? `$${r1.retryCost.toFixed(4)}` : "-";
      const r2RetryCost = r2 ? `$${r2.retryCost.toFixed(4)}` : "-";
      L.push(`| Extraction retry cost | ${r1RetryCost} | ${r2RetryCost} |`);
      L.push("");
    }

    // Per-comment diff table
    L.push("## Per-Comment Comparison");
    L.push(
      "| ExternalId | Run 1 Status | Run 2 Status | Run 1 Cost | Run 2 Cost | Cost Delta | Model Changed |",
    );
    L.push(
      "|-----------|-------------|-------------|-----------|-----------|-----------|--------------|",
    );

    // Combine all comment IDs from both runs, sort by cost delta
    const commentDiffs = allCommentIds.map((commentId) => {
      const r1 = run1Agg.get(commentId);
      const r2 = run2Agg.get(commentId);
      const externalId = externalIdMap.get(commentId) ?? commentId.slice(0, 8);
      const r1Status = r1?.status ?? "-";
      const r2Status = r2?.status ?? "-";
      const r1Cost = r1?.cost ?? 0;
      const r2Cost = r2?.cost ?? 0;
      const r1Models = r1?.models ?? new Set<string>();
      const r2Models = r2?.models ?? new Set<string>();
      const modelChanged = this.setsEqual(r1Models, r2Models)
        ? "No"
        : `Yes (${[...r1Models].join(",")}→${[...r2Models].join(",")})`;
      const statusChanged = r1Status !== r2Status;

      return {
        externalId,
        r1Status,
        r2Status,
        r1Cost,
        r2Cost,
        modelChanged,
        statusChanged,
        absDelta: Math.abs(r2Cost - r1Cost),
      };
    });

    // Sort: status changes first, then by absolute cost delta
    commentDiffs
      .sort((a, b) => {
        if (a.statusChanged !== b.statusChanged)
          return a.statusChanged ? -1 : 1;
        return b.absDelta - a.absDelta;
      })
      .forEach((d) => {
        const costDeltaStr =
          d.r1Cost > 0
            ? `${((d.r2Cost - d.r1Cost) / d.r1Cost) * 100 >= 0 ? "+" : ""}${(((d.r2Cost - d.r1Cost) / d.r1Cost) * 100).toFixed(1)}%`
            : d.r2Cost > 0
              ? "new"
              : "-";
        const statusMark = d.statusChanged ? " **" : "";
        L.push(
          `| ${d.externalId} | ${statusMark}${d.r1Status}${statusMark} | ${statusMark}${d.r2Status}${statusMark} | $${d.r1Cost.toFixed(4)} | $${d.r2Cost.toFixed(4)} | ${costDeltaStr} | ${d.modelChanged} |`,
        );
      });

    // Summary counts
    const statusChanges = commentDiffs.filter((d) => d.statusChanged).length;
    const modelChanges = commentDiffs.filter(
      (d) => d.modelChanged !== "No",
    ).length;
    L.push("");
    L.push(
      `**Summary**: ${statusChanges} status change(s), ${modelChanges} model change(s) across ${allCommentIds.length} comment(s)`,
    );

    return L.join("\n");
  }

  private aggregateByComment(
    traces: Array<{
      commentId?: string | null;
      cost?: number;
      promptTokens?: number;
      completionTokens?: number;
      cachedTokens?: number;
      model?: string;
      statusAfter: string;
    }>,
  ): Map<string, CommentRunAggregate> {
    const map = new Map<string, CommentRunAggregate>();

    for (const trace of traces) {
      // Skip thread-level traces (commentId is null for batch_init, subtree_building, etc.)
      if (!trace.commentId) continue;

      let agg = map.get(trace.commentId);
      if (!agg) {
        agg = {
          commentId: trace.commentId,
          status: trace.statusAfter,
          cost: 0,
          tokens: 0,
          cachedTokens: 0,
          calls: 0,
          models: new Set(),
        };
        map.set(trace.commentId, agg);
      }

      agg.cost += trace.cost ?? 0;
      agg.tokens += (trace.promptTokens ?? 0) + (trace.completionTokens ?? 0);
      agg.cachedTokens += trace.cachedTokens ?? 0;
      agg.calls++;
      agg.status = trace.statusAfter; // last status wins
      if (trace.model) agg.models.add(trace.model);
    }

    return map;
  }

  private computeBatchStats(
    traces: Array<{
      step: string;
      batchId?: string | null;
      cost?: number;
      data?: any;
    }>,
  ):
    | { subtreeCount: number; avgPlanNodes: number; retryCost: number }
    | undefined {
    const hasBatched = traces.some((t) =>
      ["subtree_extraction", "subtree_validation", "subtree_building"].includes(
        t.step,
      ),
    );
    if (!hasBatched) return undefined;

    // Subtree count from anchor extraction traces (one per subtree)
    const anchorExtractions = traces.filter(
      (t) =>
        t.step === "subtree_extraction" &&
        (t.data as any)?.extraction?.isAnchor === true,
    );
    const subtreeCount = anchorExtractions.length;
    const totalPlanNodes = sumBy(
      anchorExtractions,
      (t) => (t.data as any)?.extraction?.planNodeCount ?? 0,
    );

    // Retry cost
    const retryCost = sumBy(
      traces.filter(
        (t) =>
          t.step === "subtree_extraction" &&
          (t.data as any)?.extraction?.retried === true,
      ),
      (t) => t.cost ?? 0,
    );

    return {
      subtreeCount,
      avgPlanNodes: subtreeCount > 0 ? totalPlanNodes / subtreeCount : 0,
      retryCost,
    };
  }

  private sumAggregates(agg: Map<string, CommentRunAggregate>): {
    cost: number;
    tokens: number;
    cachedTokens: number;
    calls: number;
  } {
    let cost = 0,
      tokens = 0,
      cachedTokens = 0,
      calls = 0;
    for (const v of agg.values()) {
      cost += v.cost;
      tokens += v.tokens;
      cachedTokens += v.cachedTokens;
      calls += v.calls;
    }
    return { cost, tokens, cachedTokens, calls };
  }

  private formatDelta(old: number, now: number): string {
    if (old === 0) return now === 0 ? "-" : `+${now}`;
    const pct = ((now - old) / old) * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  }

  private setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }
}
