import { Injectable } from "@nestjs/common";
import {
  getPrimaryModel,
  Thread,
  ThreadProductCategory,
  ThreadRepository,
  UserComment,
  UserCommentRepository,
  ProductReference,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import {
  ThreadTraceSummary,
  CommentDebugTrace,
  ThreadMetadata,
  AggregateStats,
  CommentSummaryRow,
  Anomaly,
  SystemPromptInfo,
  PipelineStepTrace,
  ProductReferenceInfo,
  BatchDebugTrace,
  SubtreeMapDebugTrace,
  SubtreeStats,
} from "../models/thread-debug-trace";
import {
  LokiTraceReader,
  TraceFilters as BaseTraceFilters,
} from "./loki-trace-reader.service";
import { compact, isEmpty, sumBy, uniq } from "lodash";

const BATCHED_STEPS = new Set([
  "batch_init",
  "phase_0_recovery",
  "subtree_building",
  "op_summarization",
  "subtree_extraction",
  "subtree_validation",
  "registry_update",
  "config_snapshot",
]);

export interface AssemblerTraceFilters extends BaseTraceFilters {
  status?: string[];
  hasErrors?: boolean;
  flagged?: boolean;
}

@Injectable()
export class DebugTraceAssemblerService {
  constructor(
    private readonly lokiReader: LokiTraceReader,
    private readonly threadRepo: ThreadRepository,
    private readonly commentRepo: UserCommentRepository,
  ) {}

  async assembleThreadSummary(
    threadId: string,
    filters?: AssemblerTraceFilters,
  ): Promise<ThreadTraceSummary> {
    // Load thread with categories
    const thread = await this.threadRepo.findOneOrFail({
      where: { id: threadId },
      relations: [
        nameOf<Thread>("categories"),
        `${nameOf<Thread>("categories")}.${nameOf<ThreadProductCategory>("productCategory")}`,
      ],
    });

    // Load comments (lightweight)
    const comments = await this.commentRepo.find({
      where: { thread: { id: threadId } },
      relations: [nameOf<UserComment>("productReferences")],
      order: { createdAt: "ASC" },
    });

    // Apply status filter if provided
    let filteredComments = comments;
    if (filters?.status && !isEmpty(filters.status)) {
      filteredComments = comments.filter((c) =>
        filters.status!.includes(c.status),
      );
    }

    // Load traces (lightweight - only summary data)
    // Load all thread traces first (includes thread-level traces)
    const allThreadTraces = await this.lokiReader.findByThread(threadId, {
      step: filters?.step,
    });

    // Separate thread-level traces from comment-level traces
    const commentIdSet = new Set(filteredComments.map((c) => c.id));
    const threadLevelTraces = allThreadTraces.filter(
      (t) => !t.commentId || t.commentId === threadId,
    );
    const traces = allThreadTraces.filter(
      (t) =>
        t.commentId &&
        t.commentId !== threadId &&
        commentIdSet.has(t.commentId),
    );

    // Build thread metadata
    const threadMetadata: ThreadMetadata = {
      id: thread.id,
      title: thread.title,
      topic: thread.topic,
      category: thread.categories?.[0]?.productCategory?.name,
      url: thread.url,
    };

    // Compute aggregate stats
    const stats = this.computeAggregateStats(
      filteredComments,
      traces,
      comments.length,
    );

    // Build status breakdown
    const statusBreakdown = this.buildStatusBreakdown(filteredComments);

    // Build comment summary rows
    const commentRows = this.buildCommentSummaryRows(
      filteredComments,
      traces,
      filters,
    );

    // Get system prompts used
    const systemPrompts = await this.getSystemPrompts(traces);

    // Extract config snapshot from traces (check both thread-level and comment-level)
    const allTracesCombined = [...threadLevelTraces, ...traces];
    const configSnapshotTrace = allTracesCombined.find(
      (t: any) => t.step === "config_snapshot",
    );
    const configSnapshot = configSnapshotTrace
      ? (configSnapshotTrace.data as any).configSnapshot
      : undefined;

    // Build thread-level traces section
    const threadLevelTraceSummaries = threadLevelTraces
      .filter((t) => t.step !== "config_snapshot")
      .map((t) => ({
        step: t.step,
        durationMs: t.durationMs,
        cost: t.cost ?? 0,
        summary: (t.data as any).summary ?? "",
      }));

    // Compute subtree stats from traces
    const subtreeStats = this.computeSubtreeStats(allTracesCombined);

    // Identify anomalies (needs allTracesCombined for batch-specific checks)
    const anomalies = this.identifyAnomalies(
      filteredComments,
      traces,
      allTracesCombined,
    );

    return {
      thread: threadMetadata,
      stats,
      statusBreakdown,
      comments: commentRows,
      anomalies,
      systemPrompts,
      configSnapshot,
      threadLevelTraces: !isEmpty(threadLevelTraceSummaries)
        ? threadLevelTraceSummaries
        : undefined,
      subtreeStats,
    };
  }

  async assembleCommentTraces(
    commentIds: string[],
  ): Promise<CommentDebugTrace[]> {
    if (isEmpty(commentIds)) {
      return [];
    }

    // Load comments with relations
    const comments = await this.commentRepo.find({
      where: commentIds.map((id) => ({ id })),
      relations: [
        "productReferences",
        "productReferences.candidates",
        "productReferences.candidates.model",
        "productReferences.candidates.model.brand",
        "parent",
        "parent.parent",
      ],
    });

    // Load full traces for these comments
    const traces = await this.lokiReader.findByComments(commentIds);

    // Resolve system prompt hashes
    const systemPromptHashes = compact(
      traces.map((t) => (t.data as any).llm?.systemPromptHash),
    );
    const systemPromptsMap =
      await this.lokiReader.findSystemPrompts(systemPromptHashes);
    const promptMap = new Map(
      Array.from(systemPromptsMap.entries()).map(([hash, info]) => [
        hash,
        info.content,
      ]),
    );

    // Group traces by comment
    const tracesByComment = this.groupBy(traces, (t) => t.commentId!);

    // Build comment debug traces
    return comments.map((comment) => {
      const commentTraces = tracesByComment[comment.id] || [];

      const pipelineSteps: PipelineStepTrace[] = commentTraces.map((trace) => {
        let data: any = trace.data;
        if (data.llm?.systemPromptHash) {
          data = {
            ...data,
            llm: {
              ...data.llm,
              systemPrompt: promptMap.get(data.llm.systemPromptHash),
            },
          };
        }

        return {
          step: trace.step,
          iteration: trace.iteration,
          statusBefore: trace.statusBefore,
          statusAfter: trace.statusAfter,
          durationMs: trace.durationMs,
          model: trace.model,
          promptTokens: trace.promptTokens,
          completionTokens: trace.completionTokens,
          cachedTokens: trace.cachedTokens,
          cost: trace.cost,
          costLabel: trace.costLabel,
          data,
          timestamp: trace.createdAt,
        } as PipelineStepTrace;
      });

      const parentContext = comment.parent
        ? {
            id: comment.parent.id,
            externalId: comment.parent.externalId,
            body: comment.parent.body,
            grandparentBody: comment.parent.parent?.body,
          }
        : undefined;

      const latestModeration =
        comment.moderations?.[comment.moderations.length - 1];
      return {
        commentId: comment.id,
        externalId: comment.externalId,
        author: comment.authorName || comment.authorId || "Unknown",
        body: comment.body,
        status: comment.status,
        relevance: comment.relevance,
        reviewComment: latestModeration?.reviewComment,
        parentContext,
        productReferences: this.buildProductReferenceInfo(
          comment.productReferences,
        ),
        pipelineSteps,
      };
    });
  }

  formatSummaryForLlm(
    summary: ThreadTraceSummary,
    options?: {
      sortBy?: "cost" | "duration" | "index";
      limit?: number;
      offset?: number;
    },
  ): string {
    const L: string[] = [];

    L.push("# Thread Processing Debug Trace — Summary");
    L.push(`## Thread: ${summary.thread.title}`);
    L.push(
      `- ID: ${summary.thread.id} | Topic: ${summary.thread.topic} | Category: ${summary.thread.category || "None"}`,
    );
    if (summary.thread.url) L.push(`- URL: ${summary.thread.url}`);
    L.push("");

    // Aggregate stats
    const s = summary.stats;
    L.push("## Aggregate Stats");
    L.push(
      `- Total Comments: ${s.totalComments} | Traced: ${s.tracedComments}`,
    );
    L.push(`- Passed Relevance: ${s.passedRelevance} | Skipped: ${s.skipped}`);
    L.push(
      `- Approved: ${s.approved} | In Review: ${s.inReview} | Deleted: ${s.deleted}`,
    );
    L.push(
      `- LLM Calls: ${s.llmCalls} | Total Cost: $${s.totalCost.toFixed(4)} | Total Duration: ${(s.totalDurationMs / 1000).toFixed(1)}s`,
    );

    // Model usage breakdown
    const models = Object.entries(s.modelBreakdown);
    if (!isEmpty(models)) {
      const totalCalls = sumBy(models, ([, m]) => m.calls);
      L.push("- Model Breakdown:");
      for (const [model, usage] of models.sort(
        (a, b) => b[1].calls - a[1].calls,
      )) {
        const pct =
          totalCalls > 0 ? ((usage.calls / totalCalls) * 100).toFixed(0) : "0";
        const cacheInfo =
          usage.cachedTokens > 0
            ? ` (${usage.cachedTokens} cached, ${((usage.cachedTokens / usage.tokens) * 100).toFixed(0)}% hit rate)`
            : "";
        L.push(
          `  - ${model}: ${usage.calls} calls (${pct}%) | $${usage.cost.toFixed(4)} | ${usage.tokens} tokens${cacheInfo}`,
        );
      }
    }
    L.push("");

    // Config snapshot (if available)
    if (summary.configSnapshot) {
      L.push("## Config Snapshot (at processing start)");
      const cs = summary.configSnapshot;
      if (cs["processor"]) {
        const sections = [
          "relevance",
          "extraction",
          "moderation",
          "pipeline",
        ] as const;
        for (const section of sections) {
          const sectionData = cs["processor"][section];
          if (!isEmpty(sectionData)) {
            L.push(`- **${section}**: ${JSON.stringify(sectionData)}`);
          }
        }
      }
      if (!isEmpty(cs["pipeline"])) {
        L.push(`- **pipeline**: ${JSON.stringify(cs["pipeline"])}`);
      }
      if (cs["debug"]) {
        L.push(`- **debug**: traceEnabled=${cs["debug"].traceEnabled}`);
      }
      L.push("");
    }

    // Subtree structure (batched pipeline)
    if (summary.subtreeStats) {
      const ss = summary.subtreeStats;
      L.push("## Subtree Structure");
      L.push(
        `Subtrees: ${ss.subtreeCount} | Avg PLAN nodes: ${ss.avgPlanNodes.toFixed(1)} | Avg CONTEXT nodes: ${ss.avgContextNodes.toFixed(1)}`,
      );
      if (ss.opSummarized) {
        L.push(
          `OP summarized: Yes (${ss.opOriginalChars} chars -> ${ss.opSummaryChars} chars)`,
        );
      } else {
        L.push("OP summarized: No");
      }
      if (ss.extractionTotal > 0) {
        const pct =
          ss.extractionRetries > 0
            ? ` (${((ss.extractionRetries / ss.extractionTotal) * 100).toFixed(0)}%)`
            : "";
        L.push(
          `Extraction retries: ${ss.extractionRetries}/${ss.extractionTotal} subtrees${pct}`,
        );
      }
      L.push("");
    }

    // Thread-level traces table
    if (!isEmpty(summary.threadLevelTraces)) {
      L.push("## Thread-Level Traces");
      L.push("| Step | Duration | Cost | Summary |");
      L.push("|------|----------|------|---------|");
      for (const t of summary.threadLevelTraces!) {
        const costStr = t.cost > 0 ? `$${t.cost.toFixed(4)}` : "-";
        L.push(`| ${t.step} | ${t.durationMs}ms | ${costStr} | ${t.summary} |`);
      }
      L.push("");
    }

    // System prompts used
    if (summary.systemPrompts.size > 0) {
      L.push("## System Prompts Used");
      summary.systemPrompts.forEach((info, hash) => {
        L.push(
          `- \`${info.step}-${hash}\`: ${info.step} (${info.lineCount} lines)`,
        );
      });
      L.push("");
    }

    // Comment processing results table
    let rows = [...summary.comments];
    const sortBy = options?.sortBy ?? "index";
    if (sortBy === "cost") {
      rows.sort((a, b) => b.cost - a.cost);
    } else if (sortBy === "duration") {
      rows.sort((a, b) => b.durationMs - a.durationMs);
    }

    const totalRows = rows.length;
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? totalRows;
    rows = rows.slice(offset, offset + limit);

    const rangeLabel =
      totalRows > rows.length
        ? ` (showing ${offset + 1}-${offset + rows.length} of ${totalRows}, sorted by ${sortBy})`
        : "";
    const hasSubtrees = rows.some((c) => c.subtreeIndex != null);
    L.push(`## Comment Processing Results${rangeLabel}`);
    if (hasSubtrees) {
      L.push(
        "| # | ExternalId | Subtree | Status | Relevance | Products | Flags | Cost | Duration | Issue |",
      );
      L.push(
        "|---|-----------|---------|--------|-----------|----------|-------|------|----------|-------|",
      );
      rows.forEach((c) => {
        L.push(
          `| ${c.index} | ${c.externalId} | ${c.subtreeIndex ?? "-"} | ${c.status} | ${c.relevance ?? "N/A"} | ${c.productCount} | ${c.flags} | $${c.cost.toFixed(4)} | ${(c.durationMs / 1000).toFixed(1)}s | ${c.issue || ""} |`,
        );
      });
    } else {
      L.push(
        "| # | ExternalId | Status | Relevance | Products | Flags | Cost | Duration | Issue |",
      );
      L.push(
        "|---|-----------|--------|-----------|----------|-------|------|----------|-------|",
      );
      rows.forEach((c) => {
        L.push(
          `| ${c.index} | ${c.externalId} | ${c.status} | ${c.relevance ?? "N/A"} | ${c.productCount} | ${c.flags} | $${c.cost.toFixed(4)} | ${(c.durationMs / 1000).toFixed(1)}s | ${c.issue || ""} |`,
        );
      });
    }
    L.push("");

    // Anomalies — grouped by type
    if (!isEmpty(summary.anomalies)) {
      L.push(`## Anomalies (${summary.anomalies.length} items need attention)`);
      const groups: Record<string, { title: string; items: Anomaly[] }> = {
        flagged_reference: { title: "Flagged References", items: [] },
        moderation_issue: { title: "Moderation Issues", items: [] },
        high_miss_rate: { title: "High Extraction Miss Rate", items: [] },
        subtree_budget_exceeded: {
          title: "Subtree Budget Exceeded",
          items: [],
        },
        all_fast_path: {
          title: "All Fast-Path (review thresholds)",
          items: [],
        },
        error: { title: "Errors", items: [] },
      };
      summary.anomalies.forEach((a) => {
        (groups[a.type]?.items ?? groups["error"].items).push(a);
      });
      Object.values(groups)
        .filter((g) => !isEmpty(g.items))
        .forEach((g) => {
          L.push(`### ${g.title} (${g.items.length})`);
          g.items.forEach((a) => L.push(`- ${a.externalId}: ${a.description}`));
          L.push("");
        });
    }

    return L.join("\n");
  }

  formatDetailForLlm(
    summary: ThreadTraceSummary,
    commentTraces: CommentDebugTrace[],
  ): string {
    const L: string[] = [];

    L.push("# Thread Processing Debug Trace — Detail");
    L.push(`## Thread: ${summary.thread.title}`);
    L.push(
      `- ID: ${summary.thread.id} | Category: ${summary.thread.category || "None"}`,
    );
    L.push("");

    // System prompts (full content, deduplicated — shown once)
    const allPromptHashes = this.collectSystemPromptHashes(commentTraces);
    if (summary.systemPrompts.size > 0 && allPromptHashes.size > 0) {
      L.push("## System Prompts");
      summary.systemPrompts.forEach((info, hash) => {
        if (!allPromptHashes.has(hash)) return;
        L.push(`### ${info.step}-${hash}`);
        L.push("```");
        L.push(info.content);
        L.push("```");
        L.push("");
      });
    }

    // Comment traces
    commentTraces.forEach((comment, idx) => {
      if (idx > 0) L.push("---");
      L.push(`## Comment: ${comment.externalId}`);
      L.push("### Comment Body");
      L.push("```");
      L.push(comment.body);
      L.push("```");
      L.push(
        `- Author: u/${comment.author} | Status: ${comment.status} | Relevance: ${comment.relevance ?? "N/A"}`,
      );
      if (comment.reviewComment) L.push(`- Review: ${comment.reviewComment}`);
      L.push("");

      // Parent context
      if (comment.parentContext) {
        L.push("### Parent Context");
        L.push(`Parent (${comment.parentContext.externalId}):`);
        L.push("```");
        L.push(comment.parentContext.body);
        L.push("```");
        if (comment.parentContext.grandparentBody) {
          L.push("Grandparent:");
          L.push("```");
          L.push(comment.parentContext.grandparentBody);
          L.push("```");
        }
        L.push("");
      }

      // Product references (final state)
      if (!isEmpty(comment.productReferences)) {
        L.push("### Product References (Final State)");
        comment.productReferences.forEach((ref) => {
          const resolved = ref.resolvedProduct
            ? `${ref.resolvedProduct.brand} ${ref.resolvedProduct.name}`
            : "Unresolved";
          const flagStr = ref.flagged ? " FLAGGED" : "";
          L.push(
            `- "${ref.displayName}" → ${resolved} (relevance: ${ref.relevance}, enabled: ${ref.enabled}${flagStr})`,
          );
        });
        L.push("");
      }

      // Pipeline steps with step-specific rendering
      if (!isEmpty(comment.pipelineSteps)) {
        L.push("### Pipeline Steps");
        comment.pipelineSteps.forEach((step, i) => {
          L.push("");
          L.push(
            `#### ${i + 1}. ${step.step.toUpperCase()} (${step.statusBefore} → ${step.statusAfter}) — ${step.durationMs}ms`,
          );

          if (step.model) {
            const cachedInfo = step.cachedTokens
              ? ` (${step.cachedTokens} cached)`
              : "";
            L.push(
              `- Model: ${step.model} | Tokens: ${step.promptTokens ?? 0}+${step.completionTokens ?? 0}${cachedInfo} | Cost: $${(step.cost ?? 0).toFixed(6)}`,
            );
          }

          this.formatStepData(step, L);
        });
      }

      L.push("");
    });

    return L.join("\n");
  }

  /**
   * Build a minimal ThreadTraceSummary for single-comment LLM output.
   * Resolves system prompts from the comment's pipeline steps.
   */
  buildMinimalSummary(trace: CommentDebugTrace): ThreadTraceSummary {
    const systemPrompts = new Map<string, SystemPromptInfo>();
    trace.pipelineSteps.forEach((step) => {
      const llm = (step.data as any).llm;
      if (llm?.systemPromptHash && llm?.systemPrompt) {
        systemPrompts.set(llm.systemPromptHash, {
          hash: llm.systemPromptHash,
          step: step.step,
          lineCount: llm.systemPrompt.split("\n").length,
          content: llm.systemPrompt,
        });
      }
    });

    return {
      thread: { id: "", title: "Single Comment Trace", topic: "", url: "" },
      stats: {
        totalComments: 1,
        tracedComments: 1,
        passedRelevance: 0,
        skipped: 0,
        approved: 0,
        inReview: 0,
        deleted: 0,
        llmCalls: trace.pipelineSteps.filter((s) => (s.data as any).llm).length,
        totalCost: sumBy(trace.pipelineSteps, (s) => s.cost || 0),
        totalDurationMs: sumBy(trace.pipelineSteps, "durationMs"),
        modelBreakdown: trace.pipelineSteps.reduce(
          (acc, s) => {
            if (!s.model) return acc;
            const entry = acc[s.model] ?? {
              calls: 0,
              cost: 0,
              tokens: 0,
              cachedTokens: 0,
            };
            entry.calls++;
            entry.cost += s.cost || 0;
            entry.tokens += (s.promptTokens || 0) + (s.completionTokens || 0);
            entry.cachedTokens += s.cachedTokens || 0;
            acc[s.model] = entry;
            return acc;
          },
          {} as Record<
            string,
            {
              calls: number;
              cost: number;
              tokens: number;
              cachedTokens: number;
            }
          >,
        ),
      },
      statusBreakdown: {},
      comments: [],
      anomalies: [],
      systemPrompts,
    };
  }

  async assembleProductTraces(
    productId: string,
  ): Promise<{ traces: PipelineStepTrace[] }> {
    const rawTraces = await this.lokiReader.findByProduct(productId, {
      step: ["product_rating", "feature_highlights", "use_case_scoring"],
    });

    const traces: PipelineStepTrace[] = rawTraces.map((trace) => ({
      step: trace.step,
      iteration: trace.iteration,
      statusBefore: trace.statusBefore,
      statusAfter: trace.statusAfter,
      durationMs: trace.durationMs,
      model: trace.model,
      tokens: {
        prompt: trace.promptTokens,
        completion: trace.completionTokens,
        cached: trace.cachedTokens,
      },
      cost: trace.cost,
      costLabel: trace.costLabel,
      data: trace.data as any,
      timestamp: trace.createdAt,
    }));

    return { traces };
  }

  async assembleReviewTraces(
    reviewId: string,
  ): Promise<{ traces: PipelineStepTrace[] }> {
    const rawTraces = await this.lokiReader.findByReview(reviewId);

    const traces: PipelineStepTrace[] = rawTraces.map((trace) => ({
      step: trace.step,
      iteration: trace.iteration,
      statusBefore: trace.statusBefore,
      statusAfter: trace.statusAfter,
      durationMs: trace.durationMs,
      model: trace.model,
      tokens: {
        prompt: trace.promptTokens,
        completion: trace.completionTokens,
        cached: trace.cachedTokens,
      },
      cost: trace.cost,
      costLabel: trace.costLabel,
      data: trace.data as any,
      timestamp: trace.createdAt,
    }));

    return { traces };
  }

  formatProductTracesForLlm(traces: PipelineStepTrace[]): string {
    const L: string[] = [];
    L.push("# Product Rating Traces");
    L.push("");

    for (const trace of traces) {
      L.push(
        `## Step: ${trace.step} (${trace.statusBefore} → ${trace.statusAfter})`,
      );
      if (trace.timestamp) {
        L.push(`Time: ${new Date(trace.timestamp).toISOString()}`);
      }
      L.push("");
      this.formatStepData(trace, L);
      L.push("");
    }

    return L.join("\n");
  }

  // ── Private helpers ─────────────────────────────────────────────

  private computeAggregateStats(
    comments: any[],
    traces: any[],
    totalComments: number,
  ): AggregateStats {
    const tracedComments = new Set(traces.map((t) => t.commentId)).size;
    const countByStatus = (status: string) =>
      comments.filter((c) => c.status === status).length;

    // Build model usage breakdown
    const modelBreakdown: Record<
      string,
      { calls: number; cost: number; tokens: number; cachedTokens: number }
    > = {};
    for (const t of traces) {
      if (!t.model) continue;
      const entry = modelBreakdown[t.model] ?? {
        calls: 0,
        cost: 0,
        tokens: 0,
        cachedTokens: 0,
      };
      entry.calls++;
      entry.cost += t.cost || 0;
      entry.tokens += (t.promptTokens || 0) + (t.completionTokens || 0);
      entry.cachedTokens += t.cachedTokens || 0;
      modelBreakdown[t.model] = entry;
    }

    return {
      totalComments,
      tracedComments,
      passedRelevance: comments.filter((c) =>
        [
          "RELEVANCE_CALCULATED",
          "PLANNED",
          "EXTRACTED",
          "RESOLVED",
          "APPROVED",
        ].includes(c.status),
      ).length,
      skipped: countByStatus("SKIPPED"),
      approved: countByStatus("APPROVED"),
      inReview: countByStatus("IN_REVIEW"),
      deleted: countByStatus("DELETED"),
      llmCalls: traces.filter((t) => (t.data as any).llm).length,
      totalCost: sumBy(traces, (t) => t.cost || 0),
      totalDurationMs: sumBy(traces, "durationMs"),
      modelBreakdown,
    };
  }

  private buildStatusBreakdown(comments: any[]): Record<string, number> {
    return comments.reduce(
      (acc, c) => {
        acc[c.status] = (acc[c.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
  }

  private buildCommentSummaryRows(
    comments: any[],
    traces: any[],
    filters?: AssemblerTraceFilters,
  ): CommentSummaryRow[] {
    const tracesByComment = this.groupBy(traces, (t: any) => t.commentId);

    return comments
      .map((comment: any, index: number) => {
        const commentTraces = tracesByComment[comment.id] || [];
        const totalDuration = sumBy(commentTraces, (t: any) => t.durationMs);
        const totalCost = sumBy(commentTraces, (t: any) => t.cost || 0);
        const hasError = commentTraces.some((t: any) => (t.data as any).error);
        const productCount = comment.productReferences?.length || 0;
        const flagCount =
          comment.productReferences?.filter((r: any) => r.flagged).length ?? 0;

        // Extract subtree index from extraction or validation trace
        const extractionTrace = commentTraces.find(
          (t: any) => t.step === "subtree_extraction",
        );
        const validationTrace = commentTraces.find(
          (t: any) => t.step === "subtree_validation",
        );
        const subtreeIndex: number | undefined =
          (extractionTrace?.data as any)?.extraction?.subtreeIndex ??
          (validationTrace?.data as any)?.validation?.subtreeIndex;

        // Apply filters
        if (filters?.hasErrors && !hasError) return null;
        if (filters?.flagged && flagCount === 0) return null;

        let issue = "";
        if (hasError) {
          issue = "error in pipeline";
        } else if (flagCount > 0) {
          issue = `${flagCount} reference(s) flagged`;
        } else if (comment.status === "IN_REVIEW") {
          issue = "requires review";
        }

        return {
          index: index + 1,
          commentId: comment.id,
          externalId: comment.externalId,
          status: comment.status,
          relevance: comment.relevance,
          productCount,
          flags: flagCount,
          durationMs: totalDuration,
          cost: totalCost,
          issue,
          subtreeIndex,
        } as CommentSummaryRow;
      })
      .filter(Boolean) as CommentSummaryRow[];
  }

  private identifyAnomalies(
    comments: any[],
    traces: any[],
    allTraces?: any[],
  ): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const tracesByComment = this.groupBy(traces, (t: any) => t.commentId);

    comments.forEach((comment: any) => {
      const commentTraces = tracesByComment[comment.id] || [];

      // Errors
      const errorTrace = commentTraces.find((t: any) => (t.data as any).error);
      if (errorTrace) {
        anomalies.push({
          type: "error",
          commentId: comment.id,
          externalId: comment.externalId,
          description: `${errorTrace.step} step threw error — "${(errorTrace.data as any).error.message}"`,
        });
      }

      // Flagged references
      (comment.productReferences ?? [])
        .filter((ref: any) => ref.flagged)
        .forEach((ref: any) => {
          const name = ref.context?.identification?.displayName ?? "Unknown";
          anomalies.push({
            type: "flagged_reference",
            commentId: comment.id,
            externalId: comment.externalId,
            description: `"${name}" flagged${ref.reviewComment ? ` — ${ref.reviewComment}` : ""}`,
          });
        });

      // Moderation issues (deleted or in_review with moderation trace)
      if (comment.status === "DELETED" || comment.status === "IN_REVIEW") {
        const modTrace = commentTraces.find(
          (t: any) => t.step === "moderation",
        );
        if (modTrace) {
          anomalies.push({
            type: "moderation_issue",
            commentId: comment.id,
            externalId: comment.externalId,
            description: `${comment.status.toLowerCase()} by moderator — ${(modTrace.data as any).summary || "see traces"}`,
          });
        }
      }
    });

    // ── Batch-specific anomaly detection (requires allTraces) ────────────────
    if (allTraces) {
      const commentMap = new Map(comments.map((c: any) => [c.id, c]));

      // high_miss_rate: extraction miss rate > 0.20 on any anchor trace
      const anchorExtractionTraces = allTraces.filter(
        (t: any) =>
          t.step === "subtree_extraction" &&
          (t.data as any)?.extraction?.isAnchor === true,
      );
      for (const t of anchorExtractionTraces) {
        const ext = (t.data as any).extraction;
        if ((ext?.missRate ?? 0) > 0.2) {
          const comment = t.commentId ? commentMap.get(t.commentId) : undefined;
          anomalies.push({
            type: "high_miss_rate",
            commentId: t.commentId ?? "",
            externalId:
              comment?.externalId ?? t.commentId?.slice(0, 8) ?? "N/A",
            description: `Subtree #${ext.subtreeIndex} extraction miss rate ${(ext.missRate * 100).toFixed(0)}% (>${20}% threshold)${ext.retried ? " — retried" : ""}`,
          });
        }
      }

      // subtree_budget_exceeded: subtree estimated tokens > hardBudget from building trace
      const buildingTrace = allTraces.find(
        (t: any) => t.step === "subtree_building",
      );
      const buildingData = (buildingTrace?.data as any)?.subtreeBuilding;
      const configTrace = allTraces.find(
        (t: any) => t.step === "config_snapshot",
      );
      const hardBudget =
        (configTrace?.data as any)?.configSnapshot?.analysisBuilder
          ?.hardBudget ?? 10000;
      if (buildingData?.subtrees) {
        for (const st of buildingData.subtrees) {
          if ((st.estimatedTokens ?? 0) > hardBudget) {
            // Find anchor comment for this subtree
            const anchorTrace = allTraces.find(
              (t: any) =>
                t.step === "subtree_extraction" &&
                (t.data as any)?.extraction?.subtreeIndex === st.index &&
                (t.data as any)?.extraction?.isAnchor === true,
            );
            const comment = anchorTrace?.commentId
              ? commentMap.get(anchorTrace.commentId)
              : undefined;
            anomalies.push({
              type: "subtree_budget_exceeded",
              commentId: anchorTrace?.commentId ?? "",
              externalId:
                comment?.externalId ??
                anchorTrace?.commentId?.slice(0, 8) ??
                "N/A",
              description: `Subtree #${st.index} estimated ${st.estimatedTokens} tokens exceeds hard budget of ${hardBudget}`,
            });
          }
        }
      }
    }

    return anomalies;
  }

  private async getSystemPrompts(
    traces: any[],
  ): Promise<Map<string, SystemPromptInfo>> {
    const hashes = new Set(
      compact(traces.map((t) => (t.data as any).llm?.systemPromptHash)),
    );
    if (hashes.size === 0) return new Map();

    const promptsMap = await this.lokiReader.findSystemPrompts(
      Array.from(hashes),
    );
    const result = new Map<string, SystemPromptInfo>();
    for (const [hash, info] of promptsMap.entries()) {
      result.set(hash, {
        hash,
        step: info.step,
        lineCount: info.content.split("\n").length,
        content: info.content,
      });
    }
    return result;
  }

  private buildProductReferenceInfo(
    refs?: ProductReference[],
  ): ProductReferenceInfo[] {
    if (!refs?.length) return [];
    return refs.map((ref) => {
      const resolved = getPrimaryModel(ref);
      return {
        id: ref.id,
        displayName:
          ref.searchContext?.input?.displayName ??
          ref.context?.identification?.displayName ??
          "Unknown",
        resolvedProduct: resolved
          ? {
              id: resolved.id,
              name: resolved.displayName,
              brand: resolved.brand?.name ?? "Unknown",
            }
          : undefined,
        relevance: ref.relevance ?? 0,
        enabled: ref.enabled,
        flagged: ref.flagged,
      };
    });
  }

  // ── Step-specific LLM formatting ──────────────────────────────

  private formatStepData(step: PipelineStepTrace, L: string[]): void {
    const data = step.data as any;

    if (data.summary) L.push(`- Summary: ${data.summary}`);
    if (data.decision)
      L.push(`- Decision: ${data.decision.action} — ${data.decision.reason}`);
    if (data.error) L.push(`- **Error**: ${data.error.message}`);

    // Step-specific rendering
    switch (step.step) {
      case "relevance":
        this.formatRelevanceStep(data, L);
        break;
      case "planning":
        this.formatPlanningStep(data, L);
        break;
      case "extraction":
        this.formatExtractionStep(data, L);
        break;
      case "resolution":
      case "subtree_resolution":
        this.formatResolutionStep(data, L);
        break;
      case "moderation":
        this.formatModerationStep(data, L);
        break;
      case "config_snapshot":
        this.formatConfigSnapshotStep(data, L);
        break;
      case "subtree_extraction":
        this.formatSubtreeExtractionStep(data, L);
        break;
      case "subtree_validation":
        this.formatSubtreeValidationStep(data, L);
        break;
      case "batch_init":
      case "phase_0_recovery":
        this.formatBatchInitStep(data, L);
        break;
      case "subtree_building":
        this.formatSubtreeBuildingStep(data, L);
        break;
      case "op_summarization":
        this.formatOpSummarizationStep(data, L);
        break;
      case "registry_update":
        this.formatRegistryUpdateStep(data, L);
        break;
      case "review_creation":
        this.formatReviewCreationStep(data, L);
        break;
      case "product_rating":
        this.formatProductRatingStep(data, L);
        break;
      case "feature_highlights":
        this.formatFeatureHighlightsStep(data, L);
        break;
      case "use_case_scoring":
        this.formatUseCaseScoringStep(data, L);
        break;
      default:
        this.formatLlmData(data, L);
        break;
    }
  }

  private formatRelevanceStep(data: any, L: string[]): void {
    const r = data.relevance;
    if (!r) return;
    L.push(
      `- Score: ${r.score}, Threshold: ${r.threshold}, Decision: ${r.passed ? "passed" : "skipped"}`,
    );
    if (r.components) {
      const c = r.components;
      L.push(
        `- Components: fuzzy=${c.fuzzyScore?.toFixed(2)}, diversity=${c.diversity?.toFixed(2)}, reviewIntent=${c.reviewIntentMultiplier?.toFixed(2)}, penalty=${c.penaltyMultiplier?.toFixed(2)}, deliberation=${c.deliberationMultiplier?.toFixed(2)}, depth=${c.depthMultiplier?.toFixed(2)}, brandBoost=${c.brandBoost?.toFixed(2)}, productTerms=${c.productTermContribution?.toFixed(2)}`,
      );
      if (c.topTerms?.length) {
        L.push(
          `- Top terms: ${c.topTerms.map((t: any) => `${t.keyword}(${t.score?.toFixed(1)}/${t.maxScore?.toFixed(1)})`).join(", ")}`,
        );
      }
    }
    if (r.refs?.length) {
      L.push(`- References (${r.refs.length}):`);
      for (const ref of r.refs) {
        L.push(
          `  - ${ref.refId?.slice(0, 8)}: score=${ref.score}, enabled=${ref.enabled}`,
        );
        if (ref.factors) {
          const f = ref.factors;
          L.push(
            `    Factors: depth=${f.depthMultiplier?.toFixed(2)}, quoteQuality=${f.quoteQualityMultiplier?.toFixed(2)}, sentiment=${f.sentimentMultiplier?.toFixed(2)}, feature=${f.featureMultiplier?.toFixed(2)}, useCase=${f.useCaseMultiplier?.toFixed(2)}, intent=${f.intentMultiplier?.toFixed(2)}, exp=${f.experienceMultiplier?.toFixed(2)}+${f.experienceFloorBonus}`,
          );
        }
        if (ref.inputs) {
          L.push(
            `    Inputs: ${ref.inputs.depth}/${ref.inputs.experience}/${ref.inputs.sentiment}, quotes=${ref.inputs.quoteCount}, features=${ref.inputs.featureCount}, useCases=${ref.inputs.useCaseCount}`,
          );
        }
        if (ref.contentScore != null) {
          L.push(
            `    Content score (pre-experience): ${ref.contentScore.toFixed(1)}`,
          );
        }
      }
    }
  }

  private formatPlanningStep(data: any, L: string[]): void {
    const p = data.planning;
    if (p) {
      if (p.modelSelection) {
        L.push(
          `- Model selection: ${p.modelSelection.model} (complexity: ${p.modelSelection.complexity}${p.modelSelection.rationale ? ", " + p.modelSelection.rationale : ""})`,
        );
      }
      L.push(
        `- Mentions: ${p.rawMentions} raw → ${p.validatedMentions} validated (${p.hallucinatedSpansRemoved} hallucinated spans removed)`,
      );
    }
    this.formatLlmData(data, L);
  }

  private formatExtractionStep(data: any, L: string[]): void {
    const e = data.extraction;
    if (e) {
      if (e.inputMentions?.length) {
        L.push(
          `- Input mentions: ${e.inputMentions.map((m: any) => m.displayName).join(", ")}`,
        );
      }
      if (e.extractedProducts?.length) {
        e.extractedProducts.forEach((p: any) => {
          const quotes = p.quotes?.length ? ` (${p.quotes.length} quotes)` : "";
          L.push(
            `  - Extracted: ${p.displayName}${p.sentiment ? " [" + p.sentiment + "]" : ""}${quotes}`,
          );
        });
      }
      if (e.referencesCreated?.length) {
        L.push(
          `- References created: ${e.referencesCreated.map((r: any) => `${r.id?.slice(0, 8) ?? "N/A"} (rel=${r.relevance}, enabled=${r.enabled})`).join(", ")}`,
        );
      }
    }
    this.formatLlmData(data, L);
  }

  private formatResolutionStep(data: any, L: string[]): void {
    const r = data.resolution;
    if (!r) return;

    if (r.inputValidation) {
      L.push(
        `- Input validation: ${r.inputValidation.valid ? "valid" : "invalid"}${r.inputValidation.reason ? ` (${r.inputValidation.reason})` : ""}`,
      );
    }
    if (r.earlyExitReason) {
      L.push(`- Early exit: ${r.earlyExitReason}`);
    }

    if (r.input) {
      L.push(
        `- Input: "${r.input.displayName ?? "N/A"}" (brand: ${r.input.brand ?? "N/A"}, model: ${r.input.model ?? "N/A"})`,
      );
    }

    if (r.registryHit != null) {
      L.push(`- Registry hit: ${r.registryHit ? "yes" : "no"}`);
    }
    if (r.registryBypassReason) {
      L.push(`- Registry bypass reason: ${r.registryBypassReason}`);
    }

    if (r.refinedInput) {
      L.push(
        `- Refined: brand=${r.refinedInput.brand ?? "N/A"}, model=${r.refinedInput.model ?? "N/A"}, category=${r.refinedInput.category ?? "N/A"}`,
      );
    }

    if (r.candidateFunnel) {
      L.push(
        `- Candidate funnel: fuzzy=${r.candidateFunnel.fuzzyHits}, embedding=${r.candidateFunnel.embeddingHits}, post-dedupe=${r.candidateFunnel.afterDedupe}`,
      );
    }

    if (r.productCandidates?.length) {
      L.push("- Candidates:");
      r.productCandidates.slice(0, 5).forEach((c: any) => {
        const displayName = compact([c.brand, c.name]).join(" ") || c.id;
        const metrics: string[] = [];
        if (c.distance != null)
          metrics.push(`distance: ${c.distance.toFixed(3)}`);
        if (c.score != null) metrics.push(`score: ${c.score}`);
        if (c.confidence != null) metrics.push(`confidence: ${c.confidence}`);
        if (c.source) metrics.push(`source: ${c.source}`);
        L.push(
          `  - ${displayName}${metrics.length ? ` (${metrics.join(", ")})` : ""}`,
        );
      });
      if (r.productCandidates.length > 5) {
        L.push(`  - ... and ${r.productCandidates.length - 5} more`);
      }
    }

    if (r.webSearchAttempts?.length) {
      L.push(`- Web search: ${r.webSearchAttempts.length} attempt(s)`);
      r.webSearchAttempts.forEach((attempt: any, index: number) => {
        const details: string[] = [`trigger=${attempt.trigger}`];
        if (attempt.keyword) details.push(`query="${attempt.keyword}"`);
        if (attempt.provider) details.push(`provider=${attempt.provider}`);
        if (attempt.source) details.push(`source=${attempt.source}`);
        if (attempt.cacheHit != null)
          details.push(`cacheHit=${attempt.cacheHit}`);
        if (attempt.cacheEntryId)
          details.push(`cacheEntry=${attempt.cacheEntryId.slice(0, 8)}`);
        if (attempt.serpResultCount != null)
          details.push(`results=${attempt.serpResultCount}`);
        if (attempt.discoveredVariants?.length)
          details.push(`variants=${attempt.discoveredVariants.length}`);
        if (attempt.refinedInput) {
          const refined = compact([
            attempt.refinedInput.brand,
            attempt.refinedInput.model,
          ]).join(" ");
          if (refined) details.push(`refined="${refined}"`);
        }
        L.push(`  [${index + 1}] ${details.join(" | ")}`);
      });
    } else if (r.webSearchAttempts) {
      L.push("- Web search: not used");
    }

    if (r.resolvedProduct) {
      const resolvedName =
        r.resolvedProduct.displayName ??
        compact([r.resolvedProduct.brand, r.resolvedProduct.name])
          .join(" ")
          .trim();
      L.push(
        `- Resolved to: ${resolvedName || "N/A"} (${r.resolvedProduct.id?.slice(0, 8) ?? "N/A"})`,
      );
    } else {
      L.push("- Resolved to: **NONE**");
    }

    if (r.matchOutcome) {
      const mo = r.matchOutcome;
      if (mo.rejected) {
        L.push(
          `- Match outcome: rejected${mo.rejectionReason ? ` (${mo.rejectionReason})` : ""}`,
        );
        if (mo.diagnostics?.failedGates?.length) {
          L.push(`  - Failed gates: ${mo.diagnostics.failedGates.join(", ")}`);
        }
      } else if (mo.matchResult) {
        const mr = mo.matchResult;
        const parts: string[] = [];
        if (mr.score != null) parts.push(`score=${mr.score.toFixed(1)}`);
        if (mr.alias) parts.push(`alias="${mr.alias}"`);
        if (mr.components) {
          parts.push(`stringSim=${mr.components.stringSimilarity?.toFixed(2)}`);
          parts.push(`tokenOverlap=${mr.components.tokenOverlap?.toFixed(2)}`);
        }
        L.push(`- Match outcome: accepted (${parts.join(", ")})`);
        if (mo.diagnostics?.normalizedInput) {
          L.push(`  - Normalized input: "${mo.diagnostics.normalizedInput}"`);
        }
      }
    }

    if (r.contextualResolution) {
      const cr = r.contextualResolution;
      if (cr.resolved) {
        const parts: string[] = [`confidence=${cr.confidence}`];
        if (cr.statusBeforeResolution)
          parts.push(`preStatus=${cr.statusBeforeResolution}`);
        if (cr.overrodeMatcherPick) parts.push("OVERRODE matcher pick");
        L.push(`- Contextual resolution: resolved (${parts.join(", ")})`);
        if (cr.reason) L.push(`  - Reason: ${cr.reason}`);
      } else {
        L.push(
          `- Contextual resolution: not resolved (confidence=${cr.confidence})`,
        );
        if (cr.reason) L.push(`  - Reason: ${cr.reason}`);
      }
    }

    if (r.phaseTimings) {
      const timings = Object.entries(r.phaseTimings)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(", ");
      L.push(`- Phase timings: ${timings}`);
    }
    this.formatLlmData(data, L);
  }

  private formatModerationStep(data: any, L: string[]): void {
    const m = data.moderation;
    if (m?.moderatorOutput) {
      L.push(`- Moderator output: status=${m.moderatorOutput.status}`);
      if (m.moderatorOutput.flags?.length) {
        L.push(`- Flags: ${m.moderatorOutput.flags.join(", ")}`);
      }
      if (m.moderatorOutput.necessaryFixes?.length) {
        L.push(
          `- Necessary fixes: ${m.moderatorOutput.necessaryFixes.join(", ")}`,
        );
      }
    }
    this.formatLlmData(data, L);
  }

  private formatConfigSnapshotStep(data: any, L: string[]): void {
    const cs = data.configSnapshot;
    if (!cs) return;
    L.push("- Config recorded at processing start (see summary for details)");
  }

  private formatLlmData(data: any, L: string[]): void {
    if (!data.llm) return;
    L.push(`- System prompt: \`${data.llm.systemPromptHash ?? "inline"}\``);
    if (data.llm.userPrompt) {
      L.push("- User Prompt:");
      L.push("```");
      L.push(data.llm.userPrompt);
      L.push("```");
    }
    if (data.llm.rawResponse) {
      L.push("- LLM Response:");
      L.push("```json");
      L.push(data.llm.rawResponse);
      L.push("```");
    }
    if (data.llm.validationResult) {
      const vr = data.llm.validationResult;
      const parts: string[] = [];
      if (vr.filtered?.length) parts.push(`${vr.filtered.length} filtered`);
      if (vr.hallucinatedSpansRemoved)
        parts.push(`${vr.hallucinatedSpansRemoved} hallucinated spans removed`);
      if (vr.deduplicationCount)
        parts.push(`${vr.deduplicationCount} deduplicated`);
      if (parts.length) L.push(`- Validation: ${parts.join(", ")}`);
    }
  }

  // ── Batched Pipeline: New Assembler Methods ──────────────────

  async assembleBatchTrace(batchId: string): Promise<BatchDebugTrace> {
    const traces = await this.lokiReader.findByBatchId(batchId);
    if (isEmpty(traces)) {
      throw new Error(`No traces found for batchId: ${batchId}`);
    }

    // Find the anchor trace (first trace with this batchId)
    const anchorTrace = traces[0];
    const data = anchorTrace.data as any;
    const step = (
      data.extraction ? "subtree_extraction" : "subtree_validation"
    ) as "subtree_extraction" | "subtree_validation";
    const subtreeIndex =
      data.extraction?.subtreeIndex ?? data.validation?.subtreeIndex ?? 0;

    // Load thread metadata with categories
    const thread = await this.threadRepo.findOneOrFail({
      where: { id: anchorTrace.threadId },
      relations: [
        nameOf<Thread>("categories"),
        `${nameOf<Thread>("categories")}.${nameOf<ThreadProductCategory>("productCategory")}`,
      ],
    });
    const threadMetadata: ThreadMetadata = {
      id: thread.id,
      title: thread.title,
      topic: thread.topic,
      category: thread.categories?.[0]?.productCategory?.name,
      url: thread.url,
    };

    // Resolve system prompt hash for anchor
    let anchorData: any = anchorTrace.data;
    if (anchorData.llm?.systemPromptHash) {
      const promptsMap = await this.lokiReader.findSystemPrompts([
        anchorData.llm.systemPromptHash,
      ]);
      const promptInfo = promptsMap.get(anchorData.llm.systemPromptHash);
      if (promptInfo) {
        anchorData = {
          ...anchorData,
          llm: { ...anchorData.llm, systemPrompt: promptInfo.content },
        };
      }
    }

    const anchorPipelineStep: PipelineStepTrace = {
      step: anchorTrace.step,
      iteration: anchorTrace.iteration,
      statusBefore: anchorTrace.statusBefore,
      statusAfter: anchorTrace.statusAfter,
      durationMs: anchorTrace.durationMs,
      model: anchorTrace.model,
      promptTokens: anchorTrace.promptTokens,
      completionTokens: anchorTrace.completionTokens,
      cachedTokens: anchorTrace.cachedTokens,
      cost: anchorTrace.cost,
      costLabel: anchorTrace.costLabel,
      data: anchorData,
      timestamp: anchorTrace.createdAt,
    };

    // Load comments for all traces
    const commentIds = uniq(compact(traces.map((t) => t.commentId)));
    const comments = await this.commentRepo.find({
      where: commentIds.map((id) => ({ id })),
      relations: [nameOf<UserComment>("productReferences")],
      select: ["id", "externalId", "authorName", "authorId", "status"],
    });
    const commentMap = new Map(comments.map((c) => [c.id, c]));

    // Build per-comment results — use each trace's recorded cost (proportional attribution)
    const totalCost = sumBy(traces, (t) => t.cost ?? 0);
    const traceByComment = new Map(traces.map((t) => [t.commentId, t]));

    const commentResults = commentIds.map((commentId) => {
      const comment = commentMap.get(commentId);
      const commentTrace = traceByComment.get(commentId);
      const traceData = commentTrace?.data as any;

      return {
        commentId,
        externalId: comment?.externalId,
        author: comment?.authorName || comment?.authorId || "Unknown",
        status: comment?.status ?? "unknown",
        costShare: commentTrace?.cost ?? 0,
        mentions: traceData?.extraction?.extractedProducts?.length,
        quotesExtracted: traceData?.extraction?.extractedProducts?.reduce(
          (s: number, p: any) => s + (p.quotes?.length ?? 0),
          0,
        ),
        validationOutcome: traceData?.validation?.outcome,
        issues: traceData?.validation?.issues?.map((i: any) => i.issue),
      };
    });

    const totalTokens = sumBy(
      traces,
      (t) => (t.promptTokens ?? 0) + (t.completionTokens ?? 0),
    );
    const cachedTokens = sumBy(traces, (t) => t.cachedTokens ?? 0);

    return {
      batchId,
      step,
      subtreeIndex,
      threadMetadata,
      anchorTrace: anchorPipelineStep,
      commentResults,
      totalCost,
      totalTokens,
      cachedTokens,
    };
  }

  async assembleSubtreeMap(threadId: string): Promise<SubtreeMapDebugTrace> {
    const thread = await this.threadRepo.findOneOrFail({
      where: { id: threadId },
      relations: [
        nameOf<Thread>("categories"),
        `${nameOf<Thread>("categories")}.${nameOf<ThreadProductCategory>("productCategory")}`,
      ],
    });
    const threadMetadata: ThreadMetadata = {
      id: thread.id,
      title: thread.title,
      topic: thread.topic,
      category: thread.categories?.[0]?.productCategory?.name,
      url: thread.url,
    };

    // Load all traces for this thread
    const traces = await this.lokiReader.findByThread(threadId);

    // Find subtree_building trace for structure data
    const buildingTrace = traces.find((t) => t.step === "subtree_building");
    const buildingData = buildingTrace?.data as any;

    // Find config snapshot for budget info
    const configTrace = traces.find((t) => t.step === "config_snapshot");
    const configData = configTrace?.data as any;
    const subtreeBuilderConfig =
      configData?.configSnapshot?.analysisBuilder ?? {};

    const config = {
      softBudget: subtreeBuilderConfig.softBudget ?? 6000,
      hardBudget: subtreeBuilderConfig.hardBudget ?? 10000,
      maxPlanNodes: subtreeBuilderConfig.maxPlanNodes ?? 15,
      maxDepth: subtreeBuilderConfig.maxDepth ?? 8,
    };

    // Build subtree map from building trace or from extraction traces
    const subtrees: SubtreeMapDebugTrace["subtrees"] = [];

    if (buildingData?.subtreeBuilding?.subtrees) {
      // Use the building trace data directly
      for (const st of buildingData.subtreeBuilding.subtrees) {
        // Find extraction/validation batchIds for this subtree
        const extractionTraces = traces.filter(
          (t) =>
            t.step === "subtree_extraction" &&
            (t.data as any).extraction?.subtreeIndex === st.index,
        );
        const validationTraces = traces.filter(
          (t) =>
            t.step === "subtree_validation" &&
            (t.data as any).validation?.subtreeIndex === st.index,
        );

        subtrees.push({
          index: st.index,
          planNodeCount: st.planNodeCount,
          contextNodeCount: st.contextNodeCount,
          maxDepth: st.maxDepth,
          estimatedTokens: st.estimatedTokens,
          extractionBatchId: extractionTraces[0]?.batchId ?? undefined,
          validationBatchIds: compact(validationTraces.map((t) => t.batchId)),
          nodes: st.nodes ?? [],
        });
      }
    } else {
      // Fallback: reconstruct from extraction traces
      const extractionTraces = traces.filter(
        (t) => t.step === "subtree_extraction",
      );
      const bySubtree = this.groupBy(extractionTraces, (t) =>
        String((t.data as any).extraction?.subtreeIndex ?? 0),
      );

      for (const [indexStr, stTraces] of Object.entries(bySubtree)) {
        const index = parseInt(indexStr, 10);
        const firstTrace = stTraces[0];
        const ext = (firstTrace.data as any).extraction ?? {};

        subtrees.push({
          index,
          planNodeCount: ext.planNodeCount ?? stTraces.length,
          contextNodeCount: ext.contextNodeCount ?? 0,
          maxDepth: 0,
          estimatedTokens: 0,
          extractionBatchId: firstTrace.batchId ?? undefined,
          validationBatchIds: [],
          nodes: [],
        });
      }
    }

    return { threadMetadata, config, subtrees };
  }

  formatBatchTraceForLlm(batchTrace: BatchDebugTrace): string {
    const L: string[] = [];

    L.push(`## Batch Trace: ${batchTrace.batchId}`);
    L.push(
      `Step: ${batchTrace.step} | Subtree #${batchTrace.subtreeIndex} | Thread: "${batchTrace.threadMetadata.title}"`,
    );
    L.push("");

    // Batch summary
    L.push("### Batch Summary");
    const anchor = batchTrace.anchorTrace;
    if (anchor.model) {
      L.push(
        `Model: ${anchor.model} | Duration: ${(anchor.durationMs / 1000).toFixed(1)}s`,
      );
    }
    const cacheRate =
      batchTrace.totalTokens > 0
        ? ` (${batchTrace.cachedTokens} cached = ${((batchTrace.cachedTokens / batchTrace.totalTokens) * 100).toFixed(0)}%)`
        : "";
    L.push(
      `Total cost: $${batchTrace.totalCost.toFixed(4)} | Tokens: ${batchTrace.totalTokens}${cacheRate}`,
    );
    L.push("");

    // LLM data from anchor
    const anchorData = anchor.data as any;
    if (anchorData.llm?.systemPromptHash) {
      L.push(`### System Prompt`);
      L.push(`Hash: \`${anchorData.llm.systemPromptHash}\``);
      L.push("");
    }

    if (anchorData.llm) {
      const llmMeta: string[] = [];
      if (anchorData.llm.temperature != null) {
        llmMeta.push(`temperature=${anchorData.llm.temperature}`);
      }
      if (anchorData.llm.schema) {
        llmMeta.push(`schema=${anchorData.llm.schema}`);
      }
      if (anchorData.llm.retryCount != null) {
        llmMeta.push(`retryCount=${anchorData.llm.retryCount}`);
      }
      if (llmMeta.length) {
        L.push(`LLM metadata: ${llmMeta.join(" | ")}`);
        L.push("");
      }
    }

    if (anchorData.llm?.userPrompt) {
      L.push("### User Prompt");
      L.push("```");
      L.push(anchorData.llm.userPrompt);
      L.push("```");
      L.push("");
    }

    if (anchorData.llm?.rawResponse) {
      L.push("### LLM Response");
      L.push("```json");
      L.push(anchorData.llm.rawResponse);
      L.push("```");
      L.push("");
    }

    // Per-comment results table
    L.push("### Per-Comment Results");
    L.push("| Comment | Author | Status | Mentions | Quotes | Cost Share |");
    L.push("|---------|--------|--------|----------|--------|------------|");
    for (const cr of batchTrace.commentResults) {
      const id = cr.externalId ?? cr.commentId.slice(0, 8);
      L.push(
        `| ${id} | ${cr.author} | ${cr.status} | ${cr.mentions ?? "-"} | ${cr.quotesExtracted ?? "-"} | $${cr.costShare.toFixed(4)} |`,
      );
    }

    return L.join("\n");
  }

  formatSubtreeMapForLlm(subtreeMap: SubtreeMapDebugTrace): string {
    const L: string[] = [];

    L.push(`## Subtree Map: "${subtreeMap.threadMetadata.title}"`);
    const cfg = subtreeMap.config;
    L.push(
      `Config: softBudget=${cfg.softBudget}, hardBudget=${cfg.hardBudget}, maxPlanNodes=${cfg.maxPlanNodes}, maxDepth=${cfg.maxDepth}`,
    );

    const totalPlan = sumBy(subtreeMap.subtrees, "planNodeCount");
    const totalContext = sumBy(subtreeMap.subtrees, "contextNodeCount");
    L.push(
      `Total: ${subtreeMap.subtrees.length} subtrees, ${totalPlan} PLAN nodes, ${totalContext} CONTEXT nodes`,
    );
    L.push("");

    for (const st of subtreeMap.subtrees) {
      const batchInfo: string[] = [];
      if (st.extractionBatchId)
        batchInfo.push(`Extraction batch: ${st.extractionBatchId}`);
      if (st.validationBatchIds?.length)
        batchInfo.push(
          `Validation batch(es): ${st.validationBatchIds.join(", ")}`,
        );

      L.push(
        `### Subtree #${st.index} (${st.planNodeCount} PLAN, ${st.contextNodeCount} CONTEXT, depth=${st.maxDepth}${st.estimatedTokens > 0 ? `, ~${st.estimatedTokens} tokens` : ""})`,
      );
      if (!isEmpty(batchInfo)) L.push(batchInfo.join(" | "));

      if (!isEmpty(st.nodes)) {
        for (const node of st.nodes) {
          const id = node.externalId ?? node.commentId.slice(0, 8);
          const pad = "  ".repeat(Math.min(node.depth, 4));
          L.push(
            `${pad}[${node.nodeType}] ${id}  @${node.author}  depth=${node.depth}  "${node.bodyPreview}"`,
          );
        }
      } else {
        L.push(
          "  (node details not available - enable subtree_building traces)",
        );
      }
      L.push("");
    }

    return L.join("\n");
  }

  // ── Batched Pipeline: Step Formatters ───────────────────────

  private formatSubtreeExtractionStep(data: any, L: string[]): void {
    const e = data.extraction;
    if (!e) return;

    L.push(
      `- Batch: ${e.batchId} | Subtree #${e.subtreeIndex} | ${e.isAnchor ? "anchor" : "non-anchor"}`,
    );
    L.push(
      `- PLAN nodes: ${e.planNodeCount} | CONTEXT nodes: ${e.contextNodeCount} | Miss rate: ${e.missRate?.toFixed(2) ?? "N/A"} | Retried: ${e.retried ? "Yes" : "No"}`,
    );

    if (e.cheatSheetProducts != null) {
      L.push(
        `- Cheat sheet: ${e.cheatSheetProducts} products, ${e.cheatSheetChars} chars`,
      );
    }

    if (e.extractedProducts?.length) {
      L.push("- Extracted for this comment:");
      for (const p of e.extractedProducts) {
        const quotes = p.quotes?.length
          ? `${p.quotes.length} quotes`
          : "no quotes";
        L.push(
          `  -> ${p.displayName} (${quotes}${p.sentiment ? ", " + p.sentiment : ""})`,
        );
      }
    }

    if (e.referencesCreated?.length) {
      L.push(
        `- References created: ${e.referencesCreated.map((r: any) => `${r.id?.slice(0, 8) ?? "N/A"} (rel=${r.relevance}, enabled=${r.enabled})`).join(", ")}`,
      );
    }

    if (e.isAnchor) {
      L.push(
        `- Batch anchor: full LLM prompt/response below. Use get_batch_trace("${e.batchId}") to see all ${e.planNodeCount} comments side by side.`,
      );
      this.formatLlmData(data, L);
    } else {
      L.push(
        `- Non-anchor: LLM prompt/response is on the anchor trace (batchAnchorCommentId: ${e.batchAnchorCommentId}). Use get_batch_trace("${e.batchId}") to view the full batch.`,
      );
    }
  }

  private formatSubtreeValidationStep(data: any, L: string[]): void {
    const v = data.validation;
    if (!v) return;

    L.push(`- Outcome: ${v.outcome}`);

    if (v.issues?.length) {
      L.push("- Issues:");
      for (const issue of v.issues) {
        L.push(
          `  [${issue.refId?.slice(0, 8) ?? "N/A"}] ${issue.issue} - "${issue.reviewComment}"`,
        );
      }
    }

    L.push(`- Safety net override: ${v.safetyNetOverride ? "Yes" : "No"}`);

    if (v.batchId && v.isAnchor) {
      L.push(
        `- Batch anchor: ${v.batchId}. Full LLM prompt/response below. Use get_batch_trace("${v.batchId}") to see all comments side by side.`,
      );
      this.formatLlmData(data, L);
    } else if (v.batchId) {
      L.push(
        `- Non-anchor: batch ${v.batchId} (anchor: ${v.batchAnchorCommentId}). Use get_batch_trace("${v.batchId}") to view the full batch.`,
      );
    } else {
      this.formatLlmData(data, L);
    }
  }

  private formatBatchInitStep(data: any, L: string[]): void {
    const b = data.batchInit;
    if (b) {
      L.push(
        `- Processed: ${b.processedComments}, New: ${b.newComments}, Orphans: ${b.orphansRecovered}, Products loaded: ${b.productsLoaded}`,
      );
    }
  }

  private formatSubtreeBuildingStep(data: any, L: string[]): void {
    const s = data.subtreeBuilding;
    if (!s) return;
    L.push(
      `- Subtrees: ${s.subtreeCount}, PLAN nodes: ${s.totalPlanNodes}, CONTEXT nodes: ${s.totalContextNodes}`,
    );
    if (s.config) {
      L.push(
        `- Budget: soft=${s.config.softBudget}, hard=${s.config.hardBudget}, maxPlan=${s.config.maxPlanNodes}, maxDepth=${s.config.maxDepth}`,
      );
    }
  }

  private formatOpSummarizationStep(data: any, L: string[]): void {
    const o = data.opSummarization;
    if (!o) return;
    L.push(`- Action: ${o.action} | Model: ${o.model}`);
    if (o.action === "summarized") {
      L.push(`- ${o.originalLength} chars -> ${o.summaryLength} chars`);
    }
    this.formatLlmData(data, L);
  }

  private formatRegistryUpdateStep(data: any, L: string[]): void {
    const r = data.registryUpdate;
    if (!r) return;
    const hitsPart =
      r.registryHits !== undefined ? `, ${r.registryHits} registry hits` : "";
    const searchesPart =
      r.webSearches !== undefined ? `, ${r.webSearches} web searches` : "";
    L.push(
      `- Subtree #${r.subtreeIndex}: +${r.productsAdded} products (${r.totalProducts} total)${hitsPart}${searchesPart}, ${r.cheatSheetChars} chars`,
    );
  }

  private formatReviewCreationStep(data: any, L: string[]): void {
    const rc = data.reviewCreation;
    if (!rc) return;

    L.push(
      `- Review: ${rc.reviewId?.slice(0, 8)} (${rc.isNew ? "new" : "updated"}), product=${rc.productId?.slice(0, 8)}, user=${rc.userId}`,
    );

    if (rc.sourceReferences?.length) {
      L.push(`- Source references (${rc.sourceReferences.length}):`);
      for (const ref of rc.sourceReferences) {
        L.push(
          `  - ${ref.referenceId?.slice(0, 8)}: ${ref.sentiment}/${ref.experience}/${ref.depth}, rel=${ref.relevance}, quotes=${ref.quoteCount}`,
        );
      }
    }

    if (rc.sentimentAggregation) {
      const sa = rc.sentimentAggregation;
      L.push(
        `- Sentiment: ${sa.finalSentiment} (ratio=${sa.positiveRatio?.toFixed(3)}, thresholds: pos>${sa.positiveThreshold?.toFixed(2)}, neg<${sa.negativeThreshold?.toFixed(2)})`,
      );
      L.push(
        `  Weighted: positive=${sa.weightedPositive?.toFixed(3)}, total=${sa.weightedTotal?.toFixed(3)}`,
      );
    }

    if (rc.scoreBreakdown) {
      const sb = rc.scoreBreakdown;
      L.push(
        `- Score: ${sb.finalScore} (raw=${sb.rawScore}${sb.isHearsay ? ", hearsay 0.5x" : ""})`,
      );
      L.push(
        `  depth=${sb.depthScore}(${sb.depthInput}), exp=${sb.experienceScore}(${sb.experienceInput}), quality=${sb.qualityScore}, parts=${sb.partCount}, community=${sb.communityScore}(net=${sb.netVotes}), features=${sb.featureCoverageBonus}(${sb.prosCount}pro/${sb.consCount}con)`,
      );
    }
  }

  private formatProductRatingStep(data: any, L: string[]): void {
    const pr = data.productRating;
    if (!pr) return;

    L.push(
      `- Rating: ${pr.previousRating ?? "none"} → ${pr.bayesian?.finalRating ?? "none"}`,
    );
    L.push(
      `- Reviews: ${pr.filtering?.enabledReviews}/${pr.filtering?.totalReviews} (min score ${pr.filtering?.minScoreThreshold})`,
    );

    const sd = pr.sentimentDistribution;
    if (sd) {
      L.push(
        `- Sentiment: ++${sd.strongPositive ?? 0} +${sd.positive} -${sd.negative} --${sd.strongNegative ?? 0} ~${sd.mixed} =${sd.neutral} (${sd.ownerCount} owners, ${sd.prospectiveBuyerCount} prospective)`,
      );
    }

    L.push(`- Avg review score: ${pr.averageReviewScore}`);
    L.push(
      `- Weighted sentiment: sum=${pr.weightedSentimentSum?.toFixed(3)}, weight=${pr.totalWeight?.toFixed(3)}, opinionN=${pr.opinionN}, excludedNeutral=${pr.excludedNeutralCount}, pre-Bayesian=${pr.preBayesianRating ?? "null"}`,
    );

    if (pr.bayesian) {
      const b = pr.bayesian;
      L.push(
        `- Bayesian: prior=${b.priorWeight}, qualityFactor=${b.qualityFactor?.toFixed(3)}, effectivePrior=${b.effectivePriorWeight?.toFixed(3)} → ${b.finalRating}`,
      );
    }

    if (pr.perReviewWeights?.length) {
      L.push(`- Per-review weights (${pr.perReviewWeights.length}):`);
      for (const rw of pr.perReviewWeights.slice(0, 20)) {
        L.push(
          `  - ${rw.reviewId?.slice(0, 8)}: ${rw.sentiment}(${rw.sentimentScore}), score=${rw.reviewScore}, quality=${rw.qualityWeight?.toFixed(2)}, votes=${rw.netVotes}(${rw.voteMultiplier?.toFixed(2)}x), ${rw.experience}(${rw.experienceWeight}x) → weight=${rw.finalWeight?.toFixed(3)}, contribution=${rw.weightedSentiment?.toFixed(3)}`,
        );
      }
      if (pr.perReviewWeights.length > 20) {
        L.push(`  ... and ${pr.perReviewWeights.length - 20} more`);
      }
    }
  }

  private formatFeatureHighlightsStep(data: any, L: string[]): void {
    const fh = data.featureHighlights;
    if (!fh) return;

    L.push(
      `- Handson reviews: ${fh.handsonReviewCount}, feature-active users: ${fh.featureActiveUserCount}`,
    );

    if (fh.highlights?.length) {
      L.push(`- Highlights (${fh.highlights.length}):`);
      for (const h of fh.highlights) {
        L.push(
          `  - "${h.label}" [${h.direction}] score=${h.score}: ${h.proCount} pro / ${h.conCount} con (${h.mentionCount} mentions)`,
        );
        L.push(
          `    wAgreement=${h.weightedAgreement?.toFixed(2)}, agreement=${h.userAgreement?.toFixed(2)}, coverage=${h.coverage?.toFixed(2)}`,
        );
      }
    }

    if (fh.filteredOut?.length) {
      L.push(
        `- Filtered out (${fh.filteredOut.length}): ${fh.filteredOut.map((f: any) => `${f.label}(${f.score})`).join(", ")}`,
      );
    }
  }

  private formatUseCaseScoringStep(data: any, L: string[]): void {
    const uc = data.useCaseScoring;
    if (!uc) return;

    if (uc.useCases?.length) {
      L.push(`- Use cases (${uc.useCases.length}):`);
      for (const u of uc.useCases) {
        L.push(
          `  - "${u.useCase}" score=${u.score ?? "null"} (preBayesian=${u.preBayesian ?? "null"}, opinionN=${u.opinionN}): ++${u.strongPositiveCount ?? 0} +${u.positiveCount} -${u.negativeCount} --${u.strongNegativeCount ?? 0} ~${u.mixedCount} =${u.neutralCount} (${u.mentionCount} mentions, avgScore=${u.averageReviewScore})`,
        );
      }
    }

    if (uc.filteredOut?.length) {
      L.push(
        `- Filtered out (${uc.filteredOut.length}): ${uc.filteredOut.map((f: any) => `${f.useCase}(${f.mentionCount} mentions)`).join(", ")}`,
      );
    }
  }

  // ── Batched Pipeline: Stats Computation ─────────────────────

  private computeSubtreeStats(traces: any[]): SubtreeStats | undefined {
    const hasBatchedTraces = traces.some((t) => BATCHED_STEPS.has(t.step));
    if (!hasBatchedTraces) return undefined;

    // Subtree count from building trace or extraction traces
    const buildingTrace = traces.find((t) => t.step === "subtree_building");
    const buildingData = buildingTrace?.data as any;
    let subtreeCount = buildingData?.subtreeBuilding?.subtreeCount ?? 0;
    let totalPlanNodes = buildingData?.subtreeBuilding?.totalPlanNodes ?? 0;
    let totalContextNodes =
      buildingData?.subtreeBuilding?.totalContextNodes ?? 0;

    if (subtreeCount === 0) {
      // Fallback: count from extraction traces
      const extractionTraces = traces.filter(
        (t) => t.step === "subtree_extraction",
      );
      const subtreeIndices = new Set(
        extractionTraces.map((t) => (t.data as any).extraction?.subtreeIndex),
      );
      subtreeCount = subtreeIndices.size;
      totalPlanNodes = sumBy(
        extractionTraces,
        (t) => (t.data as any).extraction?.planNodeCount ?? 0,
      );
      totalContextNodes = sumBy(
        extractionTraces,
        (t) => (t.data as any).extraction?.contextNodeCount ?? 0,
      );
    }

    // OP summarization
    const opTrace = traces.find((t) => t.step === "op_summarization");
    const opData = opTrace?.data as any;
    const opSummarized = opData?.opSummarization?.action === "summarized";

    // Extraction retry stats
    const extractionTraces = traces.filter(
      (t) => t.step === "subtree_extraction",
    );
    const retries = extractionTraces.filter(
      (t) => (t.data as any).extraction?.retried === true,
    ).length;

    return {
      subtreeCount,
      avgPlanNodes: subtreeCount > 0 ? totalPlanNodes / subtreeCount : 0,
      avgContextNodes: subtreeCount > 0 ? totalContextNodes / subtreeCount : 0,
      opSummarized,
      opOriginalChars: opData?.opSummarization?.originalLength ?? 0,
      opSummaryChars: opData?.opSummarization?.summaryLength ?? 0,
      extractionRetries: retries,
      extractionTotal: extractionTraces.length,
    };
  }

  // ── Utility helpers ───────────────────────────────────────────

  private collectSystemPromptHashes(
    commentTraces: CommentDebugTrace[],
  ): Set<string> {
    const hashes = new Set<string>();
    commentTraces.forEach((c) =>
      c.pipelineSteps.forEach((s) => {
        const hash = (s.data as any).llm?.systemPromptHash;
        if (hash) hashes.add(hash);
      }),
    );
    return hashes;
  }

  private groupBy<T>(
    items: T[],
    keyFn: (item: T) => string,
  ): Record<string, T[]> {
    return items.reduce(
      (acc, item) => {
        const key = keyFn(item);
        if (!acc[key]) acc[key] = [];
        acc[key].push(item);
        return acc;
      },
      {} as Record<string, T[]>,
    );
  }
}
