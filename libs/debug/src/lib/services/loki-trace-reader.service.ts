import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { LoggerConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import { compact, isEmpty, groupBy, sumBy, uniq, sortBy } from "lodash";

export interface TraceRecord {
  id: string;
  threadId?: string;
  commentId?: string;
  batchId?: string;
  productReferenceId?: string;
  productId?: string;
  reviewId?: string;
  step: string;
  iteration: number;
  statusBefore: string;
  statusAfter: string;
  durationMs: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cost?: number;
  costLabel?: string;
  data: Record<string, any>;
  createdAt: Date;
}

export interface TraceFilters {
  step?: string[];
  commentIds?: string[];
}

export interface CostAggregationRow {
  groupKey: string;
  threadId: string;
  calls: number;
  cost: number;
  tokens: number;
  cachedTokens: number;
}

export interface TopCostCommentRow {
  commentId: string;
  threadId: string;
  cost: number;
  calls: number;
  tokens: number;
  cachedTokens: number;
  steps: string;
  models: string;
}

export interface RunBoundary {
  runIndex: number;
  startTime: Date;
  endTime: Date;
  traceCount: number;
}

const DEFAULT_LOOKBACK_HOURS = 720; // 30 days
const GAP_THRESHOLD_MS = 60_000; // 60 seconds — matches the old repository logic

@Injectable()
export class LokiTraceReader {
  private readonly logger = new CustomLogger(LokiTraceReader.name);
  private readonly lokiBaseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: LoggerConfigService,
  ) {
    this.lokiBaseUrl = config.url || "http://localhost:3100";
  }

  async findByThread(
    threadId: string,
    filters?: TraceFilters,
  ): Promise<TraceRecord[]> {
    let logql = `{log_type="processing_trace"} | json | traceType="processing_trace" | threadId="${threadId}"`;

    if (filters?.step && !isEmpty(filters.step)) {
      logql += ` | step=~"${filters.step.join("|")}"`;
    }

    if (filters?.commentIds && !isEmpty(filters.commentIds)) {
      logql += ` | commentId=~"${filters.commentIds.join("|")}"`;
    }

    return this.queryTraces(logql);
  }

  async findByBatchId(batchId: string): Promise<TraceRecord[]> {
    const logql = `{log_type="processing_trace"} | json | traceType="processing_trace" | batchId="${batchId}"`;
    return this.queryTraces(logql);
  }

  async findByComment(commentId: string): Promise<TraceRecord[]> {
    const logql = `{log_type="processing_trace"} | json | traceType="processing_trace" | commentId="${commentId}"`;
    return this.queryTraces(logql);
  }

  async findByComments(commentIds: string[]): Promise<TraceRecord[]> {
    if (isEmpty(commentIds)) return [];
    const logql = `{log_type="processing_trace"} | json | traceType="processing_trace" | commentId=~"${commentIds.join("|")}"`;
    return this.queryTraces(logql);
  }

  async findByProduct(
    productId: string,
    filters?: TraceFilters,
  ): Promise<TraceRecord[]> {
    let logql = `{log_type="processing_trace"} | json | traceType="processing_trace" | productId="${productId}"`;

    if (filters?.step && !isEmpty(filters.step)) {
      logql += ` | step=~"${filters.step.join("|")}"`;
    }

    const traces = await this.queryTraces(logql);
    return sortBy(traces, (trace) => -trace.createdAt.getTime());
  }

  async findByReview(reviewId: string): Promise<TraceRecord[]> {
    const logql = `{log_type="processing_trace"} | json | traceType="processing_trace" | reviewId="${reviewId}"`;
    const traces = await this.queryTraces(logql);
    return sortBy(traces, (trace) => -trace.createdAt.getTime());
  }

  async findByThreadInTimeRange(
    threadId: string,
    startTime: Date,
    endTime: Date,
  ): Promise<TraceRecord[]> {
    const logql = `{log_type="processing_trace"} | json | traceType="processing_trace" | threadId="${threadId}"`;
    return this.queryTraces(logql, startTime, endTime);
  }

  async findByStep(
    step: string,
    options?: {
      batchId?: string;
      limit?: number;
      order?: "ASC" | "DESC";
    },
  ): Promise<TraceRecord[]> {
    let logql = `{log_type="processing_trace"} | json | traceType="processing_trace" | step="${step}"`;

    if (options?.batchId) {
      logql += ` | batchId="${options.batchId}"`;
    }

    const direction = options?.order === "ASC" ? "forward" : "backward";
    const traces = await this.queryTraces(
      logql,
      undefined,
      undefined,
      options?.limit,
      direction,
    );

    return traces;
  }

  async findByThreads(threadIds: string[]): Promise<TraceRecord[]> {
    if (isEmpty(threadIds)) return [];
    const logql = `{log_type="processing_trace"} | json | traceType="processing_trace" | threadId=~"${threadIds.join("|")}"`;
    return this.queryTraces(logql);
  }

  async findSystemPrompts(
    hashes: string[],
  ): Promise<Map<string, { hash: string; step: string; content: string }>> {
    if (isEmpty(hashes)) return new Map();

    const logql = `{log_type="processing_trace"} | json | traceType="system_prompt" | hash=~"${hashes.join("|")}"`;
    const results = await this.queryRaw(logql);

    const promptMap = new Map<
      string,
      { hash: string; step: string; content: string }
    >();

    for (const entry of results) {
      const parsed = this.parseLogLine(entry.line);
      if (parsed?.hash && parsed?.content) {
        promptMap.set(parsed.hash, {
          hash: parsed.hash,
          step: parsed.step ?? "",
          content: parsed.content,
        });
      }
    }

    return promptMap;
  }

  async getCostAggregation(
    threadIds: string[],
    groupByField: "step" | "model" | "costLabel" | "batchId",
  ): Promise<CostAggregationRow[]> {
    const traces = await this.findByThreads(threadIds);

    const grouped: Record<string, TraceRecord[]> = {};
    for (const trace of traces) {
      const key = String(trace[groupByField] ?? "");
      if (!key) continue;
      const compositeKey = `${key}::${trace.threadId}`;
      if (!grouped[compositeKey]) grouped[compositeKey] = [];
      grouped[compositeKey].push(trace);
    }

    const results: CostAggregationRow[] = Object.entries(grouped).map(
      ([compositeKey, groupTraces]) => {
        const [groupKey, threadId] = compositeKey.split("::");
        return {
          groupKey,
          threadId,
          calls: groupTraces.length,
          cost: sumBy(groupTraces, (t) => t.cost ?? 0),
          tokens: sumBy(
            groupTraces,
            (t) => (t.promptTokens ?? 0) + (t.completionTokens ?? 0),
          ),
          cachedTokens: sumBy(groupTraces, (t) => t.cachedTokens ?? 0),
        };
      },
    );

    return sortBy(results, (r) => -r.cost);
  }

  async findTopCostComments(
    limit: number,
    threadId?: string,
    stepFilter?: string[],
  ): Promise<TopCostCommentRow[]> {
    let traces: TraceRecord[];

    if (threadId) {
      traces = await this.findByThread(threadId, {
        step: stepFilter,
      });
    } else {
      const logql =
        stepFilter && !isEmpty(stepFilter)
          ? `{log_type="processing_trace"} | json | traceType="processing_trace" | step=~"${stepFilter.join("|")}"`
          : `{log_type="processing_trace"} | json | traceType="processing_trace"`;
      traces = await this.queryTraces(logql);
    }

    const byComment = groupBy(
      traces.filter((t) => t.commentId),
      "commentId",
    );

    const results: TopCostCommentRow[] = Object.entries(byComment).map(
      ([commentId, commentTraces]) => ({
        commentId,
        threadId: commentTraces[0].threadId ?? "",
        cost: sumBy(commentTraces, (t) => t.cost ?? 0),
        calls: commentTraces.length,
        tokens: sumBy(
          commentTraces,
          (t) => (t.promptTokens ?? 0) + (t.completionTokens ?? 0),
        ),
        cachedTokens: sumBy(commentTraces, (t) => t.cachedTokens ?? 0),
        steps: uniq(compact(commentTraces.map((t) => t.step)))
          .sort()
          .join(", "),
        models: uniq(compact(commentTraces.map((t) => t.model)))
          .sort()
          .join(", "),
      }),
    );

    return sortBy(results, (r) => -r.cost).slice(0, limit);
  }

  async findRunBoundaries(threadId: string): Promise<RunBoundary[]> {
    const traces = await this.findByThread(threadId);
    if (isEmpty(traces)) return [];

    const runs: RunBoundary[] = [];
    let currentRun: RunBoundary = {
      runIndex: 0,
      startTime: traces[0].createdAt,
      endTime: traces[0].createdAt,
      traceCount: 1,
    };

    for (let i = 1; i < traces.length; i++) {
      const current = traces[i].createdAt;
      const gap = current.getTime() - currentRun.endTime.getTime();

      if (gap > GAP_THRESHOLD_MS) {
        runs.push(currentRun);
        currentRun = {
          runIndex: runs.length,
          startTime: current,
          endTime: current,
          traceCount: 1,
        };
      } else {
        currentRun.endTime = current;
        currentRun.traceCount++;
      }
    }
    runs.push(currentRun);

    return runs;
  }

  // ── Private Helpers ──────────────────────────────────────────────────────────

  private async queryTraces(
    logql: string,
    start?: Date,
    end?: Date,
    limit?: number,
    direction: "forward" | "backward" = "forward",
  ): Promise<TraceRecord[]> {
    const rawEntries = await this.queryRaw(logql, start, end, limit, direction);

    const records = compact(
      rawEntries.map((entry) => this.parseTraceEntry(entry)),
    );

    if (direction === "forward") {
      return sortBy(records, (r) => r.createdAt.getTime());
    }
    return sortBy(records, (r) => -r.createdAt.getTime());
  }

  private async queryRaw(
    logql: string,
    start?: Date,
    end?: Date,
    limit?: number,
    direction: "forward" | "backward" = "forward",
  ): Promise<Array<{ timestamp: string; line: string }>> {
    try {
      const now = new Date();
      const startNs = start
        ? String(start.getTime() * 1_000_000)
        : String(
            (now.getTime() - DEFAULT_LOOKBACK_HOURS * 3600 * 1000) * 1_000_000,
          );
      const endNs = end
        ? String(end.getTime() * 1_000_000)
        : String(now.getTime() * 1_000_000);

      const params: Record<string, string> = {
        query: logql,
        start: startNs,
        end: endNs,
        limit: String(limit ?? 5000),
        direction,
      };

      const response = await this.httpService.axiosRef.get(
        `${this.lokiBaseUrl}/loki/api/v1/query_range`,
        { params },
      );

      const streams = response.data?.data?.result ?? [];
      const entries: Array<{ timestamp: string; line: string }> = [];

      for (const stream of streams) {
        for (const [timestamp, line] of stream.values ?? []) {
          entries.push({ timestamp, line });
        }
      }

      return entries;
    } catch (error) {
      this.logger.warn("Loki query failed, returning empty results", {
        error,
        query: logql,
      });
      return [];
    }
  }

  private parseTraceEntry(entry: {
    timestamp: string;
    line: string;
  }): TraceRecord | undefined {
    const parsed = this.parseLogLine(entry.line);
    if (!parsed || parsed.traceType !== "processing_trace") return undefined;

    return {
      id: parsed.id ?? `loki-${entry.timestamp}`,
      threadId: parsed.threadId ?? undefined,
      commentId: parsed.commentId ?? undefined,
      batchId: parsed.batchId ?? undefined,
      productReferenceId: parsed.productReferenceId ?? undefined,
      productId: parsed.productId ?? undefined,
      reviewId: parsed.reviewId ?? undefined,
      step: parsed.step ?? "unknown",
      iteration: parsed.iteration ?? 0,
      statusBefore: parsed.statusBefore ?? "",
      statusAfter: parsed.statusAfter ?? "",
      durationMs: parsed.durationMs ?? 0,
      model: parsed.model ?? undefined,
      promptTokens: parsed.promptTokens ?? undefined,
      completionTokens: parsed.completionTokens ?? undefined,
      cachedTokens: parsed.cachedTokens ?? undefined,
      cost: parsed.cost != null ? Number(parsed.cost) : undefined,
      costLabel: parsed.costLabel ?? undefined,
      data: parsed.data ?? {},
      createdAt: this.parseTimestamp(entry.timestamp),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseLogLine(line: string): any | undefined {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }

  private parseTimestamp(lokiTimestamp: string): Date {
    // Loki timestamps are nanoseconds since epoch
    const ms = Math.floor(Number(lokiTimestamp) / 1_000_000);
    return new Date(ms);
  }
}
