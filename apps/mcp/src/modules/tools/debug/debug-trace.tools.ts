import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import {
  DebugTraceAssemblerService,
  AssemblerTraceFilters,
} from "@ebike-backend/debug";

@Injectable()
export class DebugTraceTools {
  constructor(private readonly assembler: DebugTraceAssemblerService) {}

  @Tool({
    name: "get_batch_trace",
    description:
      "Get detailed batch trace for a subtree extraction/validation batch by batchId, including prompt/response and per-comment outcomes.",
    parameters: z.object({
      batchId: z.string().describe("Batch ID from processing traces"),
    }),
  })
  async getBatchTrace(args: { batchId: string }): Promise<string> {
    const batchTrace = await this.assembler.assembleBatchTrace(args.batchId);
    return this.assembler.formatBatchTraceForLlm(batchTrace);
  }

  @Tool({
    name: "get_thread_subtree_map",
    description:
      "Get subtree map for a thread, including subtree budgets, node counts, and linked extraction/validation batch IDs.",
    parameters: z.object({
      threadId: z.string().describe("Thread UUID"),
    }),
  })
  async getThreadSubtreeMap(args: { threadId: string }): Promise<string> {
    const subtreeMap = await this.assembler.assembleSubtreeMap(args.threadId);
    return this.assembler.formatSubtreeMapForLlm(subtreeMap);
  }

  @Tool({
    name: "get_thread_trace_summary",
    description:
      "Get a high-level overview of thread processing — comment table, anomalies, aggregate stats. Use this first to understand thread state before investigating specific comments.",
    parameters: z.object({
      threadId: z.string().describe("Thread UUID"),
      statusFilter: z
        .array(z.string())
        .optional()
        .describe('Filter comments by status (e.g. ["in_review", "approved"])'),
      stepFilter: z
        .array(z.string())
        .optional()
        .describe(
          'Filter traces by pipeline step (e.g. ["planning", "moderation"])',
        ),
      hasErrors: z
        .boolean()
        .optional()
        .describe("Only show comments with pipeline errors"),
      flagged: z
        .boolean()
        .optional()
        .describe("Only show comments with flagged product references"),
      sortBy: z
        .enum(["cost", "duration", "index"])
        .optional()
        .describe(
          "Sort comment table by cost, duration, or index (default: index)",
        ),
      limit: z
        .number()
        .optional()
        .describe("Max comments to show in table (default: all)"),
      offset: z.number().optional().describe("Skip first N comments in table"),
    }),
  })
  async getThreadTraceSummary(args: {
    threadId: string;
    statusFilter?: string[];
    stepFilter?: string[];
    hasErrors?: boolean;
    flagged?: boolean;
    sortBy?: "cost" | "duration" | "index";
    limit?: number;
    offset?: number;
  }): Promise<string> {
    const filters: AssemblerTraceFilters = {};
    if (args.statusFilter) filters.status = args.statusFilter;
    if (args.stepFilter) filters.step = args.stepFilter;
    if (args.hasErrors !== undefined) filters.hasErrors = args.hasErrors;
    if (args.flagged !== undefined) filters.flagged = args.flagged;

    const summary = await this.assembler.assembleThreadSummary(
      args.threadId,
      filters,
    );
    return this.assembler.formatSummaryForLlm(summary, {
      sortBy: args.sortBy,
      limit: args.limit,
      offset: args.offset,
    });
  }

  @Tool({
    name: "get_comment_traces",
    description:
      "Get full pipeline traces for specific comments — LLM prompts, responses, relevance scores, resolution candidates, moderation output. Use after reviewing the summary to investigate flagged or problematic comments.",
    parameters: z.object({
      commentIds: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe("Comment UUIDs to trace (max 5)"),
    }),
  })
  async getCommentTraces(args: { commentIds: string[] }): Promise<string> {
    const traces = await this.assembler.assembleCommentTraces(args.commentIds);

    if (traces.length === 0) {
      return "No traces found for the provided comment IDs.";
    }

    // Build a minimal summary for system prompt context (needed by formatDetailForLlm)
    const summary = this.assembler.buildMinimalSummary(traces[0]);
    return this.assembler.formatDetailForLlm(summary, traces);
  }

  @Tool({
    name: "get_review_trace",
    description:
      "Get full trace for a review — how ProductReferences were aggregated, sentiment breakdown, score sub-calculations. Shows why a review got its score/sentiment.",
    parameters: z.object({
      reviewId: z.string().describe("Review UUID"),
    }),
  })
  async getReviewTrace(args: { reviewId: string }): Promise<string> {
    const result = await this.assembler.assembleReviewTraces(args.reviewId);

    if (result.traces.length === 0) {
      return `No traces found for review ${args.reviewId}. Ensure debug tracing was enabled when the review was created/updated.`;
    }

    return this.assembler.formatProductTracesForLlm(result.traces);
  }

  @Tool({
    name: "get_product_rating_trace",
    description:
      "Get full rating breakdown for a product — per-review weights, Bayesian dampening, sentiment distribution, feature highlights, use case scores. Shows why a product has its current rating.",
    parameters: z.object({
      productId: z.string().describe("Product (ProductModel) UUID"),
    }),
  })
  async getProductRatingTrace(args: { productId: string }): Promise<string> {
    const result = await this.assembler.assembleProductTraces(args.productId);

    if (result.traces.length === 0) {
      return `No rating traces found for product ${args.productId}. Ensure debug tracing was enabled when the product rating was last calculated.`;
    }

    return this.assembler.formatProductTracesForLlm(result.traces);
  }
}
