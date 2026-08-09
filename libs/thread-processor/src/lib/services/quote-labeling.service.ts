import { Injectable } from "@nestjs/common";
import {
  Evidence,
  ProductReference,
  ProductReferenceRepository,
  ReferenceDetails,
  Sentiment,
} from "@ebike-backend/database";
import { AiChatService } from "@ebike-backend/ai";
import {
  buildLabelingJsonSchema,
  LabelingLLMResponse,
  LLMLabeledProduct,
} from "../schemas/quote-labeling.schema";
import { buildLabelingSystemPrompt } from "../prompts/quote-labeler.prompt";
import {
  buildCommentLabelMap,
  collectExtractedRefs,
} from "../prompts/quote-labeler.user-prompt";
import { Subtree } from "../models/subtree.model";
import { ThreadContext } from "../models/thread-context";
import { PromptAssemblyService } from "./prompt-assembly.service";
import { randomUUID } from "crypto";
import { isEmpty } from "lodash";

/**
 * Issue evidence carries a severity sentiment that is required to be one of
 * `Negative` / `StrongNegative`. The labeler schema enforces this for OpenAI
 * structured output, but we apply a programmatic gate as belt-and-braces in
 * case strict-schema mode is disabled or a future model emits an out-of-band
 * value. Anything outside the allowed pair is clamped to `Negative`. Mutates
 * in place; returns the same reference for chaining.
 */
function coerceIssueSentiment(evidence: Evidence): Evidence {
  if (
    evidence.sentiment !== Sentiment.Negative &&
    evidence.sentiment !== Sentiment.StrongNegative
  ) {
    evidence.sentiment = Sentiment.Negative;
  }
  return evidence;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LabelingOptions {
  threadId: string;
  labelingModel: string;
  thinking?: boolean;
  effort?: string;
  strictSchema?: boolean;
}

export interface LabelingTraceCall {
  batchId: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  durationMs: number;
  model: string;
  rawResponse: string;
  productLabelsCount: number;
  quoteLabelsCount: number;
}

export interface LabelingResult {
  labeledCount: number;
  traceCalls: LabelingTraceCall[];
}

@Injectable()
export class QuoteLabelingService {
  constructor(
    private readonly aiChat: AiChatService,
    private readonly productReferenceRepository: ProductReferenceRepository,
    private readonly promptAssembly: PromptAssemblyService,
  ) {}

  /**
   * Label quotes on all product references in the subtree with Evidence classification.
   * Derives positiveFeatures, negativeFeatures, and useCases from Evidence types.
   * Stores ReferenceDetails on each reference.
   */
  public async processSubtree(
    subtree: Subtree,
    context: ThreadContext,
    options: LabelingOptions,
  ): Promise<LabelingResult> {
    const refs = collectExtractedRefs(subtree);
    if (refs.length === 0) {
      return { labeledCount: 0, traceCalls: [] };
    }

    const systemPrompt = buildLabelingSystemPrompt({
      categoryConfigs: context.categoryConfigs,
    });

    const commentLabelMap = buildCommentLabelMap(subtree);
    const userPrompt = this.promptAssembly.buildLabelingPrompt(
      subtree,
      context,
      commentLabelMap,
    );

    const allowedIssueTypes = (context.categoryConfigs[0]?.issues ?? []).map(
      (issue) => issue.label,
    );
    const expectedProductIds = this.buildExpectedProductIds(
      refs,
      commentLabelMap,
    );

    const result = await this.callLLM(
      systemPrompt,
      userPrompt,
      options.labelingModel,
      subtree.id,
      options.threadId,
      allowedIssueTypes,
      expectedProductIds,
      options.thinking,
      options.effort,
      options.strictSchema,
    );

    const labeledCount = await this.applyLabels(
      refs,
      result.response,
      commentLabelMap,
    );
    const quoteLabelsCount = result.response.products.reduce(
      (sum, product) => sum + (product.quotes?.length ?? 0),
      0,
    );

    return {
      labeledCount,
      traceCalls: [
        {
          batchId: result.batchId,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          cachedTokens: result.cachedTokens,
          cost: result.cost,
          durationMs: result.durationMs,
          model: options.labelingModel,
          rawResponse: result.rawResponse,
          productLabelsCount: labeledCount,
          quoteLabelsCount,
        },
      ],
    };
  }

  // ─── LLM Call ─────────────────────────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    userPrompt: string,
    model: string,
    subtreeId: string,
    threadId: string,
    allowedIssueTypes: string[],
    expectedProductIds: string[],
    thinking?: boolean,
    effort?: string,
    strictSchema?: boolean,
  ): Promise<{
    batchId: string;
    response: LabelingLLMResponse;
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
      costLabel: "quote_labeling",
      logContext: { threadId, subtreeId },
      threadId,
      schema: buildLabelingJsonSchema(allowedIssueTypes, expectedProductIds),
      schemaName: "quote_labeling",
      traceCollector: (data) => {
        tracedCost = data.cost;
      },
      validateResponse: (parsed) =>
        this.validateLabelingResponse(
          parsed as LabelingLLMResponse,
          expectedProductIds,
        ),
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      ...(thinking !== undefined && { thinking }),
      ...(effort !== undefined && { effort }),
      ...(strictSchema !== undefined && { strictSchema }),
    });

    const content = chatResponse.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as LabelingLLMResponse;

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

  // ─── Apply Labels ─────────────────────────────────────────────────────────

  /**
   * Apply labeling LLM output to product references.
   *
   * The LLM emits three peer evidence streams per quote:
   *   - features[] — feature evidence with optional sentiment override
   *   - useCases[] — use-case evidence with optional sentiment override
   *   - issues[]   — closed-list issue label with required severity sentiment
   *
   * Each stream maps 1:1 to its destination on the quote — no merging. The
   * issue → feature contribution is a downstream concern handled by rating
   * aggregation via the category config's `IssueLabelConfig.feature` map.
   */
  private async applyLabels(
    refs: ProductReference[],
    response: LabelingLLMResponse,
    commentLabelMap: Map<string, string>,
  ): Promise<number> {
    const labeledMap = new Map<string, LLMLabeledProduct>();
    for (const labeled of response.products) {
      labeledMap.set(labeled.productId, labeled);
    }

    const commentGroups = new Map<string, ProductReference[]>();
    for (const ref of refs) {
      const commentId = ref.comment?.id;
      if (!commentId) continue;
      const bucket = commentGroups.get(commentId) ?? [];
      bucket.push(ref);
      commentGroups.set(commentId, bucket);
    }

    let labeledCount = 0;
    const refsToSave: ProductReference[] = [];

    for (const [commentId, commentRefs] of commentGroups) {
      const commentLabel = commentLabelMap.get(commentId);
      if (!commentLabel) continue;

      for (
        let productIndex = 0;
        productIndex < commentRefs.length;
        productIndex++
      ) {
        const ref = commentRefs[productIndex];
        const productLabel = String.fromCharCode(97 + productIndex);
        const productId = `${commentLabel}${productLabel}`;

        const labeled = labeledMap.get(productId);
        if (!labeled) continue;

        if (labeled.quotes?.length && ref.quotes?.length) {
          for (const labeledQuote of labeled.quotes) {
            const quote = ref.quotes[labeledQuote.quoteIndex];
            if (!quote) continue;

            quote.features = labeledQuote.features?.length
              ? (labeledQuote.features as Evidence[])
              : undefined;
            quote.useCases = labeledQuote.useCases?.length
              ? (labeledQuote.useCases as Evidence[])
              : undefined;
            quote.issues = labeledQuote.issues?.length
              ? labeledQuote.issues.map((issue) =>
                  coerceIssueSentiment({
                    label: issue.label,
                    sentiment: issue.sentiment,
                  }),
                )
              : undefined;
            quote.quality = labeledQuote.quality;
            quote.speculative =
              labeledQuote.speculative === true ? true : undefined;
          }
        }

        const refLabels = labeled.referenceLabels;
        ref.features = refLabels?.features?.length
          ? (refLabels.features as Evidence[])
          : null;
        ref.useCases = refLabels?.useCases?.length
          ? (refLabels.useCases as Evidence[])
          : null;

        if (labeled.referenceDetails && !isEmpty(labeled.referenceDetails)) {
          ref.referenceDetails = labeled.referenceDetails as ReferenceDetails;
        }

        refsToSave.push(ref);
        labeledCount++;
      }
    }

    if (refsToSave.length > 0) {
      await this.productReferenceRepository.saveAll(refsToSave);
    }

    return labeledCount;
  }

  /**
   * Reject responses where any productId is not one of the assigned
   * `Aa`-style codes. Returning display names instead of codes means
   * applyLabels can't map labels back to refs, so we throw and let the
   * chat service retry.
   */
  private validateLabelingResponse(
    response: LabelingLLMResponse,
    expectedProductIds: string[],
  ): void {
    const expected = new Set(expectedProductIds);
    const invalid = response.products
      .map((product) => product.productId)
      .filter((id) => !expected.has(id));
    if (invalid.length > 0) {
      throw new Error(
        `Labeling response contains invalid productIds: ${invalid.join(", ")}. Expected codes: ${expectedProductIds.join(", ")}.`,
      );
    }
  }

  /**
   * Build the ordered list of productIds the labeling LLM must emit,
   * e.g. ["Aa", "Ab", "Ba"]. Mirrors the assignment logic in buildLabelingTree
   * and applyLabels: comment letter (A/B/C…) + product letter (a/b/c…).
   */
  private buildExpectedProductIds(
    refs: ProductReference[],
    commentLabelMap: Map<string, string>,
  ): string[] {
    const commentGroups = new Map<string, ProductReference[]>();
    for (const ref of refs) {
      const commentId = ref.comment?.id;
      if (!commentId) continue;
      const bucket = commentGroups.get(commentId) ?? [];
      bucket.push(ref);
      commentGroups.set(commentId, bucket);
    }

    const productIds: string[] = [];
    for (const [commentId, commentRefs] of commentGroups) {
      const commentLabel = commentLabelMap.get(commentId);
      if (!commentLabel) continue;
      for (
        let productIndex = 0;
        productIndex < commentRefs.length;
        productIndex++
      ) {
        productIds.push(
          `${commentLabel}${String.fromCharCode(97 + productIndex)}`,
        );
      }
    }
    return productIds;
  }
}
