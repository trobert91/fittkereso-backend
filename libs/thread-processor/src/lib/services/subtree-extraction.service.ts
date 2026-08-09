import { Injectable } from "@nestjs/common";
import {
  CommentContext,
  CommentStatus,
  ExperienceType,
  getPrimaryModel,
  Intent,
  isHandsonExperience,
  ProductReference,
  ProductReferenceRepository,
  Quote,
  Sentiment,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { AiChatService } from "@ebike-backend/ai";
import { textExistsInSource, isSubstantiveQuote } from "@ebike-backend/utils";
import {
  ExtractionLLMResponse,
  EXTRACTION_JSON_SCHEMA,
  LLMExtractedProduct,
} from "../schemas/subtree-extraction.schema";
import { LLMMappedProduct } from "../schemas/subtree-identification.schema";
import { Subtree, SubtreeNode } from "../models/subtree.model";
import { ThreadContext } from "../models/thread-context";
import { mergeDiscoveredSpecs } from "../utils/spec-merge.util";
import { ensureQuoteIds, nextQuoteId } from "../utils/quote-id";
import { PromptAssemblyService } from "./prompt-assembly.service";
import { randomUUID } from "crypto";
import { isEmpty } from "lodash";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExtractionOptions {
  threadId: string;
  extractionModel: string;
  extractionMissRateRetryThreshold: number;
  maxQuotesCeiling: number;
  thinking?: boolean;
  effort?: string;
  /** Set of valid spec names for the active categories; empty = accept all. */
  validSpecNames: Set<string>;
  /** Product annotations from the identification step, keyed by comment ID. */
  planProductAnnotations?: Map<string, LLMMappedProduct[]>;
  /** When true, retry once if the OP comment returns no products. */
  isOpSubtree?: boolean;
}

export interface ExtractionResult {
  extractedCount: number;
  missingCount: number;
  retryTriggered: boolean;
  traceCalls: ExtractionTraceCall[];
}

export interface ExtractionTraceCall {
  batchId: string;
  subtreeId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  parsedResponse: ExtractionLLMResponse;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  durationMs: number;
  retried: boolean;
  missRate: number;
  cheatSheetChars: number;
  cheatSheetProducts: number;
  planNodes: SubtreeNode[];
  validated: ValidatedEntry[];
}

interface ValidatedEntry {
  comment: UserComment;
  products: LLMExtractedProduct[];
}

interface ValidationResult {
  validated: ValidatedEntry[];
  missingIds: Set<string>;
  missRate: number;
  hallucinated: string[];
}

interface AttemptResult {
  result: ValidationResult;
  traceCall: ExtractionTraceCall;
}

function calculateMaxQuotes(
  commentBodyLength: number,
  ceiling: number,
): number {
  let adaptive: number;
  if (commentBodyLength < 200) adaptive = 4;
  else if (commentBodyLength < 500) adaptive = 6;
  else if (commentBodyLength < 1000) adaptive = 8;
  else adaptive = 10;
  return Math.min(adaptive, ceiling);
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class SubtreeExtractionService {
  private readonly logger = new CustomLogger(SubtreeExtractionService.name);

  constructor(
    private readonly aiChat: AiChatService,
    private readonly promptAssembly: PromptAssemblyService,
    private readonly commentRepository: UserCommentRepository,
    private readonly productReferenceRepository: ProductReferenceRepository,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Main entry point — called once per subtree in the per-subtree loop. */
  async processSubtree(
    subtree: Subtree,
    context: ThreadContext,
    opts: ExtractionOptions,
  ): Promise<ExtractionResult> {
    if (isEmpty(subtree.planNodes)) {
      return {
        extractedCount: 0,
        missingCount: 0,
        retryTriggered: false,
        traceCalls: [],
      };
    }

    const model = opts.extractionModel;
    const { systemPrompt, userPrompt } =
      this.promptAssembly.buildExtractionPrompt(subtree, context, undefined, {
        planProductAnnotations: opts.planProductAnnotations,
        stripContext: true,
      });

    const traceCalls: ExtractionTraceCall[] = [];

    // ── Attempt 1 ──────────────────────────────────────────────────────────
    const { result, traceCall } = await this.executeAttempt({
      targetSubtree: subtree,
      systemPrompt,
      userPrompt,
      model,
      context,
      opts,
      retried: false,
    });
    traceCalls.push(traceCall);
    await this.saveProductMentions(result.validated, subtree);

    // ── OP retry: if the OP comment returned no products, retry once ───────
    if (opts.isOpSubtree) {
      const opEntry = result.validated[0];
      if (opEntry && isEmpty(opEntry.products)) {
        this.logger.debug("OP subtree returned no products — retrying", {
          subtreeId: subtree.id,
        });

        const { result: retryResult, traceCall: retryTraceCall } =
          await this.executeAttempt({
            targetSubtree: subtree,
            systemPrompt,
            userPrompt,
            model,
            context,
            opts,
            retried: true,
          });
        traceCalls.push(retryTraceCall);
        await this.saveProductMentions(retryResult.validated, subtree);
        await this.updateProductReferences(
          retryResult.validated,
          subtree,
          opts,
        );

        return {
          extractedCount: retryResult.validated.length,
          missingCount: retryResult.missingIds.size,
          retryTriggered: true,
          traceCalls,
        };
      }
    }

    // ── Miss-rate retry ─────────────────────────────────────────────────────
    const missRateThreshold = opts.extractionMissRateRetryThreshold;
    await this.updateProductReferences(result.validated, subtree, opts);

    if (result.missRate <= missRateThreshold) {
      return {
        extractedCount: result.validated.length,
        missingCount: result.missingIds.size,
        retryTriggered: false,
        traceCalls,
      };
    }

    const retrySubtree = this.rebuildForRetry(
      subtree,
      result.missingIds,
      context,
    );

    if (!isEmpty(retrySubtree.planNodes)) {
      const retryUserPrompt = this.promptAssembly.buildExtractionPrompt(
        retrySubtree,
        context,
        undefined,
        {
          planProductAnnotations: opts.planProductAnnotations,
          stripContext: true,
        },
      ).userPrompt;

      const { result: result2, traceCall: traceCall2 } =
        await this.executeAttempt({
          targetSubtree: retrySubtree,
          systemPrompt,
          userPrompt: retryUserPrompt,
          model,
          context,
          opts,
          retried: true,
        });
      traceCalls.push(traceCall2);
      await this.saveProductMentions(result2.validated, retrySubtree);
      await this.updateProductReferences(result2.validated, retrySubtree, opts);

      if (result2.missRate > missRateThreshold) {
        this.logger.warn(
          `Subtree ${subtree.id}: still ${(result2.missRate * 100).toFixed(0)}% missing after retry`,
        );
      }
    }

    return {
      extractedCount: result.validated.length,
      missingCount: result.missingIds.size,
      retryTriggered: true,
      traceCalls,
    };
  }

  // ─── Attempt Helper ────────────────────────────────────────────────────────

  private async executeAttempt({
    targetSubtree,
    systemPrompt,
    userPrompt,
    model,
    context,
    opts,
    retried,
  }: {
    targetSubtree: Subtree;
    systemPrompt: string;
    userPrompt: string;
    model: string;
    context: ThreadContext;
    opts: ExtractionOptions;
    retried: boolean;
  }): Promise<AttemptResult> {
    const costLabel = retried
      ? "reference_extraction_retry"
      : "reference_extraction";
    const call = await this.callLLM(
      systemPrompt,
      userPrompt,
      model,
      targetSubtree.id,
      opts.threadId,
      costLabel,
      opts.thinking,
      opts.effort,
    );
    const result = this.validate(
      call.response,
      targetSubtree,
      opts.maxQuotesCeiling,
    );
    const traceCall: ExtractionTraceCall = {
      batchId: call.batchId,
      subtreeId: targetSubtree.id,
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
      retried,
      missRate: result.missRate,
      cheatSheetChars: context.cheatSheetString?.length ?? 0,
      cheatSheetProducts: context.productRegistry.size,
      planNodes: targetSubtree.planNodes,
      validated: result.validated,
    };
    return { result, traceCall };
  }

  // ─── LLM Call ──────────────────────────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    userPrompt: string,
    model: string,
    subtreeId: string,
    threadId: string,
    costLabel: "reference_extraction" | "reference_extraction_retry",
    thinking?: boolean,
    effort?: string,
  ): Promise<{
    batchId: string;
    response: ExtractionLLMResponse;
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
      costLabel,
      logContext: { threadId, subtreeId },
      threadId,
      schema: EXTRACTION_JSON_SCHEMA,
      schemaName: "subtree_extraction",
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

    const rawContent = chatResponse.choices[0]?.message?.content ?? "";
    const content = rawContent.replace(/\\u0000/g, "").replace(/\u0000/g, "");
    const parsed = JSON.parse(content) as ExtractionLLMResponse;
    const promptTokens = chatResponse.usage?.prompt_tokens ?? 0;
    const completionTokens = chatResponse.usage?.completion_tokens ?? 0;
    const cachedTokens =
      chatResponse.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const cost = tracedCost;

    return {
      batchId: randomUUID(),
      response: parsed,
      rawResponse: content,
      promptTokens,
      completionTokens,
      cachedTokens,
      cost,
      durationMs: Date.now() - startMs,
    };
  }

  // ─── Validation Pipeline ────────────────────────────────────────────────────

  private validate(
    response: ExtractionLLMResponse,
    subtree: Subtree,
    maxQuotesCeiling: number,
  ): {
    validated: ValidatedEntry[];
    missingIds: Set<string>;
    missRate: number;
    hallucinated: string[];
  } {
    // Step 1: Short-ID resolution
    const shortIdMap = new Map<string, UserComment>(
      subtree.planNodes.map((n, i) => [`c${i}`, n.comment]),
    );

    const resolved: ValidatedEntry[] = [];
    const hallucinated: string[] = [];

    for (const entry of response.comments) {
      const comment = shortIdMap.get(entry.commentId);
      if (!comment) {
        hallucinated.push(entry.commentId);
        continue;
      }
      resolved.push({ comment, products: [...entry.products] });
    }

    if (!isEmpty(hallucinated)) {
      this.logger.debug(`Hallucinated IDs: ${hallucinated.join(", ")}`);
    }

    // Step 2: Completeness check
    const sentExternalIds = new Set(
      subtree.planNodes.map((n) => n.comment.externalId),
    );
    const returnedExtIds = new Set(resolved.map((e) => e.comment.externalId));
    const missingIds = new Set<string>();
    for (const id of sentExternalIds) {
      if (!returnedExtIds.has(id)) missingIds.add(id);
    }
    const missRate =
      sentExternalIds.size > 0 ? missingIds.size / sentExternalIds.size : 0;

    // Step 2b: Default optional arrays the LLM may omit
    for (const entry of resolved) {
      for (const product of entry.products) {
        product.quotes ??= [];
        product.intents ??= [];
      }
    }

    // Step 2c: Remap out-of-bounds productIndex values.
    // The LLM sometimes confuses per-comment [p0, p1] indices with the
    // cheat-sheet P-numbers (P1, P5, …). When a comment has exactly one
    // ProductReference and the LLM returned an index other than 0, remap to 0.
    for (const entry of resolved) {
      const refCount = entry.comment.productReferences?.length ?? 0;
      for (const product of entry.products) {
        if (product.productIndex >= refCount && refCount === 1) {
          this.logger.debug(
            `Remapping productIndex ${product.productIndex} → 0 for comment ${entry.comment.externalId} (single ref)`,
          );
          product.productIndex = 0;
        }
      }
    }

    // Step 3: Quote wrapping strip
    for (const entry of resolved) {
      for (const product of entry.products) {
        product.quotes = (product.quotes ?? []).map((q) => ({
          ...q,
          text: stripQuoteWrapping(q.text),
        }));
      }
    }

    // Step 4: Quote hallucination filter (textExistsInSource)
    for (const entry of resolved) {
      for (const product of entry.products) {
        product.quotes = (product.quotes ?? []).filter((q) =>
          textExistsInSource(q.text, entry.comment.body),
        );
      }
    }

    // Step 4b: Quote quality filter — remove obviously non-substantive quotes
    for (const entry of resolved) {
      for (const product of entry.products) {
        product.quotes = (product.quotes ?? []).filter((q) =>
          isSubstantiveQuote(q.text),
        );
      }
    }

    // Step 5: Apply adaptive quote limit
    for (const entry of resolved) {
      const maxQuotes = calculateMaxQuotes(
        entry.comment.body.length,
        maxQuotesCeiling,
      );
      for (const product of entry.products) {
        const quotes = product.quotes ?? [];
        if (quotes.length > maxQuotes) {
          product.quotes = quotes.slice(0, maxQuotes);
        }
      }
    }

    // NOTE: Step 6 (classification clearing) is REMOVED.
    // The merged extraction+labeling LLM call produces classification fields directly.

    return { validated: resolved, missingIds, missRate, hallucinated };
  }

  // ─── Save Checkpoints ──────────────────────────────────────────────────────

  /** CP1: Save productMentions to comment context, status stays unchanged. */
  private async saveProductMentions(
    entries: ValidatedEntry[],
    subtree: Subtree,
  ): Promise<void> {
    for (const entry of entries) {
      const { comment, products } = entry;

      // Resolve product names from existing ProductReferences (created by createReferencesFromMapping)
      const existingRefs = comment.productReferences ?? [];
      const mentions = products.map((product) => {
        const ref = existingRefs[product.productIndex];
        const brand = ref?.context?.identification?.brand ?? "";
        const model = ref?.context?.identification?.model ?? "";
        return {
          brand,
          model,
          displayName:
            getPrimaryModel(ref)?.displayName ?? `${brand} ${model}`.trim(),
          specs: product.specs?.map((s) => s.value),
          textSpans: [] as string[],
          category: ref?.categoryHint ?? "",
          confidence: 0,
        };
      });

      comment.context = new CommentContext({
        ...(comment.context ?? {}),
        commentBody: comment.body,
        productMentions: mentions,
      });

      await this.commentRepository.save(comment);
    }
  }

  /**
   * CP2: Update existing ProductReferences with extraction data, set status → EXTRACTED.
   * ProductReferences were already created by createReferencesFromMapping() in Phase 2.
   * This method populates quotes, sentiment, experience, depth, intents, features, useCases.
   */
  private async updateProductReferences(
    entries: ValidatedEntry[],
    subtree: Subtree,
    opts: ExtractionOptions,
  ): Promise<void> {
    for (const entry of entries) {
      const { comment, products } = entry;
      const existingRefs = comment.productReferences ?? [];

      for (const product of products) {
        const ref = existingRefs[product.productIndex];
        if (!ref) {
          this.logger.warn(
            `Product index ${product.productIndex} out of bounds for comment ${comment.externalId} (has ${existingRefs.length} refs)`,
          );
          continue;
        }

        // Populate extraction fields on existing ref.
        // Quote features/useCases are omitted here — the labeling step
        // upgrades them from flat strings to Evidence[] with classification.
        const newQuotes: Quote[] = [];
        for (const q of product.quotes ?? []) {
          newQuotes.push({
            id: nextQuoteId(newQuotes),
            text: q.text,
            sentiment: q.sentiment as Sentiment,
          });
        }
        ref.quotes = newQuotes;
        ensureQuoteIds(ref.quotes);
        ref.sentiment = product.overallSentiment;
        ref.experience = product.experience;
        ref.depth = product.depth;
        ref.intents = this.sanitizeIntents(
          product.intents ?? [],
          product.experience ?? ExperienceType.Reference,
        );

        // Handle specs the extraction step found that identification missed
        if (product.specs?.length) {
          mergeDiscoveredSpecs(ref, product.specs, opts.validSpecNames);
        }
      }

      // Save updated refs
      if (existingRefs.length > 0) {
        await this.productReferenceRepository.saveAll(existingRefs);
      }

      // Update comment: status → EXTRACTED
      comment.status = CommentStatus.EXTRACTED;
      await this.commentRepository.save(comment);
    }
  }

  // ─── Intent Sanitization ───────────────────────────────────────────────────

  private static readonly FIRSTHAND_ONLY_INTENTS = new Set<Intent>([
    Intent.IssueReport,
    Intent.ExperienceReport,
  ]);

  /**
   * Strip intents that require firsthand experience (issue_report, experience_report)
   * when the author is only a prospective_buyer or reference.
   */
  private sanitizeIntents(
    intents: Intent[],
    experience: ExperienceType,
  ): Intent[] {
    if (isHandsonExperience(experience)) {
      return intents;
    }
    return intents.filter(
      (intent) => !SubtreeExtractionService.FIRSTHAND_ONLY_INTENTS.has(intent),
    );
  }

  // ─── Retry Logic ───────────────────────────────────────────────────────────

  /** Rebuild a retry subtree: extracted → CONTEXT, missing → PLAN. */
  private rebuildForRetry(
    subtree: Subtree,
    missingIds: Set<string>,
    context: ThreadContext,
  ): Subtree {
    const newNodes: SubtreeNode[] = [];
    const newPlanNodes: SubtreeNode[] = [];

    for (const node of subtree.nodes) {
      const extId = node.comment.externalId;

      if (missingIds.has(extId)) {
        // Still missing → stays as PLAN
        const planNode: SubtreeNode = { ...node, nodeType: "PLAN" };
        newNodes.push(planNode);
        newPlanNodes.push(planNode);
      } else if (node.nodeType === "PLAN") {
        // Was PLAN and is now extracted → reclassify as CONTEXT
        const freshComment = context.getByExternalId(extId) ?? node.comment;
        newNodes.push({ ...node, comment: freshComment, nodeType: "CONTEXT" });
      } else {
        // Was already CONTEXT → unchanged
        newNodes.push(node);
      }
    }

    return {
      ...subtree,
      nodes: newNodes,
      planNodes: newPlanNodes,
    };
  }
}

// ─── Standalone Helpers ──────────────────────────────────────────────────────

function stripQuoteWrapping(text: string): string {
  const t = text.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}
