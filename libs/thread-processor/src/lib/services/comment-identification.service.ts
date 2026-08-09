import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import { AiChatService } from "@ebike-backend/ai";
import { randomUUID } from "crypto";
import { isEmpty } from "lodash";
import {
  CommentIdentificationLLMResponse,
  COMMENT_IDENTIFICATION_JSON_SCHEMA,
  LLMMappedProductRef,
} from "../schemas/comment-identification.schema";
import { Subtree, SubtreeNode } from "../models/subtree.model";
import { ThreadContext } from "../models/thread-context";
import {
  PromptAssemblyService,
  ResolvedDiscoveredProduct,
} from "./prompt-assembly.service";
import { withMissRateRetry } from "../utils/miss-rate-retry";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommentIdentificationOptions {
  threadId: string;
  model?: string;
  thinking?: boolean;
  effort?: string;
  /** Retry once when the per-comment miss rate exceeds this fraction (0..1). */
  missRateRetryThreshold: number;
}

export interface CommentIdentificationResult {
  /** Per-comment mapping from comment ID to the products it references. */
  productMap: Map<string, LLMMappedProductRef[]>;
  /** Trace data for recording, or null when identification was skipped. */
  traceCall: CommentIdentificationTraceCall | null;
}

export interface CommentIdentificationTraceCall {
  batchId: string;
  subtreeId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  parsedResponse: CommentIdentificationLLMResponse;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  durationMs: number;
  planNodes: number;
  retried: boolean;
}

interface IdentificationLLMCall {
  batchId: string;
  response: CommentIdentificationLLMResponse;
  rawResponse: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  durationMs: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Pass-1 `comment_identification` step. One LLM call (with one miss-rate retry)
 * per wide subtree that maps each [PLAN] comment to the already-resolved
 * distinct products (by discovery letter) — or surfaces a product discovery
 * missed. LLM-only: returns a per-comment product map; the coordinator creates
 * the references.
 */
@Injectable()
export class CommentIdentificationService {
  private readonly logger = new CustomLogger(CommentIdentificationService.name);

  constructor(
    private readonly aiChat: AiChatService,
    private readonly promptAssembly: PromptAssemblyService,
  ) {}

  async identify(
    subtree: Subtree,
    context: ThreadContext,
    resolved: ResolvedDiscoveredProduct[],
    opts: CommentIdentificationOptions,
  ): Promise<CommentIdentificationResult> {
    if (isEmpty(subtree.planNodes)) {
      return { productMap: new Map(), traceCall: null };
    }

    const { systemPrompt, userPrompt } =
      this.promptAssembly.buildCommentIdentificationPrompt(
        subtree,
        context,
        resolved,
      );

    // Short ID (c0, c1, …) per PLAN node, in render order.
    const planNodeMap = new Map<string, SubtreeNode>();
    const expectedIds: string[] = [];
    subtree.planNodes.forEach((node, index) => {
      const shortId = `c${index}`;
      planNodeMap.set(shortId, node);
      expectedIds.push(shortId);
    });

    const model = opts.model ?? "deepseek-v4-flash";
    let retried = false;
    const call = await withMissRateRetry<IdentificationLLMCall>({
      expectedIds,
      threshold: opts.missRateRetryThreshold,
      attempt: () =>
        this.callLLM(
          systemPrompt,
          userPrompt,
          model,
          subtree.id,
          opts.threadId,
          opts.thinking,
          opts.effort,
        ),
      coveredIds: (result) =>
        new Set(result.response.comments.map((c) => c.commentId)),
      onRetry: (missRate) => {
        retried = true;
        this.logger.warn("Comment identification miss-rate retry", {
          subtreeId: subtree.id,
          missRate,
          threshold: opts.missRateRetryThreshold,
        });
      },
    });

    // Build the per-comment product map keyed by real comment id.
    const productMap = new Map<string, LLMMappedProductRef[]>();
    for (const entry of call.response.comments) {
      const node = planNodeMap.get(entry.commentId);
      if (!node) continue;
      if (!isEmpty(entry.products)) {
        productMap.set(node.comment.id, entry.products);
      }
    }

    const traceCall: CommentIdentificationTraceCall = {
      batchId: call.batchId,
      subtreeId: subtree.id,
      model,
      systemPrompt,
      userPrompt,
      rawResponse: call.rawResponse,
      parsedResponse: call.response,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      cachedTokens: call.cachedTokens,
      cost: call.cost,
      durationMs: call.durationMs,
      planNodes: subtree.planNodes.length,
      retried,
    };

    this.logger.log("Comment identification completed", {
      subtreeId: subtree.id,
      planNodes: subtree.planNodes.length,
      mappedComments: productMap.size,
      cost: call.cost,
    });

    return { productMap, traceCall };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    userPrompt: string,
    model: string,
    subtreeId: string,
    threadId: string,
    thinking?: boolean,
    effort?: string,
  ): Promise<IdentificationLLMCall> {
    const startMs = Date.now();
    let tracedCost = 0;
    const chatResponse = await this.aiChat.createChat({
      costLabel: "comment_identification",
      logContext: { threadId, subtreeId },
      threadId,
      schema: COMMENT_IDENTIFICATION_JSON_SCHEMA,
      schemaName: "comment_identification",
      traceCollector: (data) => {
        tracedCost = data.cost;
      },
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 1,
      ...(thinking !== undefined && { thinking }),
      ...(effort !== undefined && { effort }),
    });

    const content = chatResponse.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as CommentIdentificationLLMResponse;

    return {
      batchId: randomUUID(),
      response: parsed,
      rawResponse: content,
      promptTokens: chatResponse.usage?.prompt_tokens ?? 0,
      completionTokens: chatResponse.usage?.completion_tokens ?? 0,
      cachedTokens:
        chatResponse.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cost: tracedCost,
      durationMs: Date.now() - startMs,
    };
  }
}
