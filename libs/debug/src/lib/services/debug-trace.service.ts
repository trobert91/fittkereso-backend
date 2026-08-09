import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { ProcessingTraceData } from "../models/processing-trace-data";
import { TraceLoggerService } from "./trace-logger.service";

export interface RecordTraceInput {
  threadId?: string;
  commentId?: string;
  batchId?: string;
  productReferenceId?: string;
  productId?: string;
  reviewId?: string;
  step: string;
  iteration?: number;
  statusBefore: string;
  statusAfter: string;
  durationMs: number;
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cost?: number;
  costLabel?: string;
  data: ProcessingTraceData & {
    llm?: {
      systemPrompt?: string;
      systemPromptHash?: string;
      [key: string]: any;
    };
  };
}

export interface RecordLlmCallUsageInput {
  threadId: string;
  model: string;
  provider?: string;
  cost?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  costLabel?: string;
}

export interface ThreadRunModelUsageStat {
  model: string;
  provider: string | null;
  callCount: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface ThreadRunCostLabelStat {
  costUsd: number;
  llmCallCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface ThreadRunStats {
  totalCost: number;
  modelsUsed: ThreadRunModelUsageStat[];
  costByLabel: Record<string, ThreadRunCostLabelStat>;
}

const UNKNOWN_COST_LABEL = "unknown";

@Injectable()
export class DebugTraceService {
  private readonly runCostAccumulator = new Map<string, number>();
  private readonly modelUsageAccumulator = new Map<
    string,
    Map<string, ThreadRunModelUsageStat>
  >();
  private readonly costLabelAccumulator = new Map<
    string,
    Map<string, ThreadRunCostLabelStat>
  >();

  constructor(
    private readonly traceLogger: TraceLoggerService,
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  /** Returns accumulated cost for a thread without resetting it. Reads the
   *  same authoritative accumulator that `flushThreadRunStats` uses, so the
   *  intermediate "Thread total cost" log line agrees with the final
   *  ThreadRun.totalCostUsd record and includes every LLM call (image
   *  analysis, identification, extraction, etc.) — not just calls whose
   *  pipeline phase emitted a `record()` with a cost field. */
  peekThreadCost(threadId: string): number {
    return this.runCostAccumulator.get(threadId) ?? 0;
  }

  /** Returns and resets accumulated run stats (cost + per-model usage + per-label usage) for a thread. */
  flushThreadRunStats(threadId: string): ThreadRunStats {
    const totalCost = this.runCostAccumulator.get(threadId) ?? 0;
    const modelsMap = this.modelUsageAccumulator.get(threadId);
    const modelsUsed = modelsMap ? Array.from(modelsMap.values()) : [];

    const labelsMap = this.costLabelAccumulator.get(threadId);
    const costByLabel: Record<string, ThreadRunCostLabelStat> = {};
    if (labelsMap) {
      for (const [label, stat] of labelsMap.entries()) {
        costByLabel[label] = stat;
      }
    }

    this.runCostAccumulator.delete(threadId);
    this.modelUsageAccumulator.delete(threadId);
    this.costLabelAccumulator.delete(threadId);

    return { totalCost, modelsUsed, costByLabel };
  }

  /**
   * Record one canonical LLM-call accounting entry. Called once per real LLM
   * call (not per derived/per-comment trace). Drives the per-run analytics
   * stored on `ThreadRun` (totalCostUsd + details breakdown).
   */
  recordLlmCallUsage(input: RecordLlmCallUsageInput): void {
    const cost = input.cost ?? 0;
    const promptTokens = input.promptTokens ?? 0;
    const completionTokens = input.completionTokens ?? 0;
    const cachedTokens = input.cachedTokens ?? 0;

    const currentRun = this.runCostAccumulator.get(input.threadId) ?? 0;
    this.runCostAccumulator.set(input.threadId, currentRun + cost);

    const provider = input.provider ?? null;
    const modelKey = `${provider ?? "unknown"}:${input.model}`;
    let modelsForThread = this.modelUsageAccumulator.get(input.threadId);
    if (!modelsForThread) {
      modelsForThread = new Map();
      this.modelUsageAccumulator.set(input.threadId, modelsForThread);
    }
    const existingModel = modelsForThread.get(modelKey);
    if (existingModel) {
      existingModel.callCount += 1;
      existingModel.costUsd += cost;
      existingModel.promptTokens += promptTokens;
      existingModel.completionTokens += completionTokens;
      existingModel.cachedTokens += cachedTokens;
    } else {
      modelsForThread.set(modelKey, {
        model: input.model,
        provider,
        callCount: 1,
        costUsd: cost,
        promptTokens,
        completionTokens,
        cachedTokens,
      });
    }

    const label = input.costLabel ?? UNKNOWN_COST_LABEL;
    let labelsForThread = this.costLabelAccumulator.get(input.threadId);
    if (!labelsForThread) {
      labelsForThread = new Map();
      this.costLabelAccumulator.set(input.threadId, labelsForThread);
    }
    const existingLabel = labelsForThread.get(label);
    if (existingLabel) {
      existingLabel.costUsd += cost;
      existingLabel.llmCallCount += 1;
      existingLabel.promptTokens += promptTokens;
      existingLabel.completionTokens += completionTokens;
      existingLabel.cachedTokens += cachedTokens;
    } else {
      labelsForThread.set(label, {
        costUsd: cost,
        llmCallCount: 1,
        promptTokens,
        completionTokens,
        cachedTokens,
      });
    }
  }

  async record(input: RecordTraceInput): Promise<void> {
    try {
      // Per-thread cost is accumulated centrally in `recordLlmCallUsage`
      // (called by AiChatService on every LLM call), so we do NOT
      // accumulate `input.cost` here — that would double-count when a
      // pipeline phase traces an LLM-driven event.

      if (!this.dynamicConfig.debug?.traceEnabled) {
        return;
      }

      let processedData: any = { ...input.data };

      if (input.data.llm?.systemPrompt) {
        const systemPrompt = input.data.llm.systemPrompt;
        const hash = this.hashSystemPrompt(systemPrompt);

        // Log system prompt as a separate Loki entry
        this.traceLogger.writeSystemPrompt(hash, systemPrompt, input.step);

        const { systemPrompt: _, ...llmWithoutPrompt } = input.data.llm;
        processedData = {
          ...input.data,
          llm: {
            ...llmWithoutPrompt,
            systemPromptHash: hash,
          },
        };
      }

      this.traceLogger.writeTrace({
        threadId: input.threadId ?? null,
        commentId: input.commentId ?? null,
        batchId: input.batchId ?? null,
        productReferenceId: input.productReferenceId ?? null,
        productId: input.productId ?? null,
        reviewId: input.reviewId ?? null,
        step: input.step,
        iteration: input.iteration ?? 0,
        statusBefore: input.statusBefore,
        statusAfter: input.statusAfter,
        durationMs: Math.round(input.durationMs),
        model: input.model ?? null,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        cachedTokens: input.cachedTokens ?? null,
        cost: input.cost ?? null,
        costLabel: input.costLabel ?? null,
        data: processedData,
      });
    } catch (error) {
      // Silently fail — trace errors should never break the pipeline
      console.error("Failed to record debug trace:", error);
    }
  }

  private hashSystemPrompt(prompt: string): string {
    const hash = createHash("sha256").update(prompt).digest("hex");
    return hash.substring(0, 12);
  }
}
