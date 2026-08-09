import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import { AiChatService } from "@ebike-backend/ai";
import { randomUUID } from "crypto";
import { isEmpty } from "lodash";
import {
  ProductDiscoveryLLMResponse,
  PRODUCT_DISCOVERY_JSON_SCHEMA,
  LLMDiscoveredProduct,
} from "../schemas/product-discovery.schema";
import { Subtree } from "../models/subtree.model";
import { ThreadContext } from "../models/thread-context";
import { PromptAssemblyService } from "./prompt-assembly.service";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiscoveryOptions {
  threadId: string;
  model?: string;
  thinking?: boolean;
  effort?: string;
}

export interface DiscoveryResult {
  /** Distinct products surfaced by the LLM (product-centric, pooled evidence). */
  products: LLMDiscoveredProduct[];
  /** Trace data for recording, or null when discovery was skipped. */
  traceCall: DiscoveryTraceCall | null;
}

export interface DiscoveryTraceCall {
  batchId: string;
  subtreeId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  parsedResponse: ProductDiscoveryLLMResponse;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  durationMs: number;
  distinctProducts: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Pass-1 `product_discovery` step. One LLM call per wide subtree that extracts
 * the DISTINCT set of products with pooled resolution evidence — product-centric
 * output, not yet mapped to comments. LLM-only: no persistence, no registry
 * writes. The coordinator enriches + resolves the returned products.
 *
 * Note: discovery's output is product-centric, not comment-keyed, so the
 * per-comment miss-rate retry used by comment identification does not apply
 * here — a single call is correct.
 */
@Injectable()
export class ProductDiscoveryService {
  private readonly logger = new CustomLogger(ProductDiscoveryService.name);

  constructor(
    private readonly aiChat: AiChatService,
    private readonly promptAssembly: PromptAssemblyService,
  ) {}

  async discover(
    subtree: Subtree,
    context: ThreadContext,
    opts: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    if (isEmpty(subtree.planNodes)) {
      return { products: [], traceCall: null };
    }

    const { systemPrompt, userPrompt } =
      this.promptAssembly.buildDiscoveryPrompt(subtree, context);

    const model = opts.model ?? "deepseek-v4-flash";
    const call = await this.callLLM(
      systemPrompt,
      userPrompt,
      model,
      subtree.id,
      opts.threadId,
      opts.thinking,
      opts.effort,
    );

    const traceCall: DiscoveryTraceCall = {
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
      distinctProducts: call.response.products.length,
    };

    this.logger.log("Product discovery completed", {
      subtreeId: subtree.id,
      distinctProducts: call.response.products.length,
      cost: call.cost,
    });

    return { products: call.response.products, traceCall };
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
  ): Promise<{
    batchId: string;
    response: ProductDiscoveryLLMResponse;
    rawResponse: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cost: number;
    durationMs: number;
  }> {
    const startMs = Date.now();
    let tracedCost = 0;
    const chatResponse = await this.aiChat.createChat({
      costLabel: "product_discovery",
      logContext: { threadId, subtreeId },
      threadId,
      schema: PRODUCT_DISCOVERY_JSON_SCHEMA,
      schemaName: "product_discovery",
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
    const parsed = JSON.parse(content) as ProductDiscoveryLLMResponse;

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
