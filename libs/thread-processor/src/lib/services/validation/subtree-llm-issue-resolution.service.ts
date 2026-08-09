import { Injectable } from "@nestjs/common";
import {
  CommentModeration,
  CommentStatus,
  CommentTree,
  ContentQuality,
  Depth,
  ExperienceType,
  Intent,
  ProductReference,
  ProductReferenceRepository,
  Sentiment,
  UserComment,
  UserCommentRepository,
  ValidationIssue,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { AiChatService } from "@ebike-backend/ai";
import { DebugTraceService } from "@ebike-backend/debug";
import { isEmpty } from "lodash";
import { buildValidationIssue, IssueResolver, VALIDATION_ISSUE_TYPES } from ".";
import { Subtree } from "../../models/subtree.model";
import { ThreadContext } from "../../models/thread-context";
import { SubtreeBuilderService } from "../subtree-builder.service";
import {
  LlmEmittedIssue,
  LlmValidationResponse,
  LLM_VALIDATION_JSON_SCHEMA,
} from "../../schemas/llm-validation.schema";
import {
  buildValidationSystemPrompt,
  buildValidationUserPrompt,
} from "../../prompts/llm-validation.prompt";
import { ValidationSubtreeRenderer } from "./validation-subtree-renderer";

export interface LlmResolutionOpts {
  threadId: string;
  subtreeIndex: number;
  validationModel: string;
  validationSoftBudget?: number;
  validationHardBudget?: number;
  validationMaxNodes?: number;
  validationMaxDepth?: number;
  thinking?: boolean;
  effort?: string;
}

@Injectable()
export class SubtreeLlmIssueResolutionService {
  private readonly logger = new CustomLogger(
    SubtreeLlmIssueResolutionService.name,
  );

  constructor(
    private readonly aiChat: AiChatService,
    private readonly subtreeBuilder: SubtreeBuilderService,
    private readonly renderer: ValidationSubtreeRenderer,
    private readonly issueResolver: IssueResolver,
    private readonly productReferenceRepository: ProductReferenceRepository,
    private readonly userCommentRepository: UserCommentRepository,
    private readonly debugTrace: DebugTraceService,
  ) {}

  async resolve(
    subtree: Subtree,
    tree: CommentTree,
    context: ThreadContext,
    opts: LlmResolutionOpts,
  ): Promise<void> {
    const phaseStart = Date.now();
    if (isEmpty(subtree.planNodes)) return;

    const validationSubtreeMap = this.subtreeBuilder.buildSubtrees(
      tree,
      context,
      {
        softBudget: opts.validationSoftBudget ?? 4000,
        hardBudget: opts.validationHardBudget ?? 7000,
        maxPlanNodes: opts.validationMaxNodes ?? 10,
        maxDepth: opts.validationMaxDepth ?? 8,
      },
    );
    const validationSubtrees = [
      validationSubtreeMap.opSubtree,
      ...validationSubtreeMap.subtrees,
    ].filter((s) => !isEmpty(s.planNodes));

    const planCommentIds = new Set(subtree.planNodes.map((n) => n.comment.id));

    const refsById = new Map<string, ProductReference>();
    const commentsById = new Map<string, UserComment>();
    for (const { comment } of subtree.planNodes) {
      commentsById.set(comment.id, comment);
      for (const ref of comment.productReferences ?? []) {
        refsById.set(ref.id, ref);
      }
    }

    const llmIssuesByRef = new Map<string, ValidationIssue[]>();
    const llmModerationsByComment = new Map<string, CommentModeration[]>();
    let totalCost = 0;
    let llmCallCount = 0;

    // Build the system prompt once per resolve() call. Category config is
    // thread-wide and doesn't change between validation subtrees.
    const systemPrompt = buildValidationSystemPrompt({
      categoryConfigs: context.categoryConfigs,
    });

    for (const vSubtree of validationSubtrees) {
      const filteredPlanNodes = vSubtree.planNodes.filter((n) =>
        planCommentIds.has(n.comment.id),
      );
      if (isEmpty(filteredPlanNodes)) continue;
      const scopedSubtree: Subtree = {
        ...vSubtree,
        planNodes: filteredPlanNodes,
      };
      const { rendered, labelToRefId, labelToCommentId } =
        this.renderer.render(scopedSubtree);
      if (!rendered.trim()) continue;

      let response: LlmValidationResponse | undefined;
      let callCost = 0;
      try {
        const result = await this.callLlm(
          rendered,
          opts,
          vSubtree.id,
          systemPrompt,
        );
        response = result.response;
        callCost = result.cost;
      } catch (error) {
        this.logger.error(
          `LLM validation error for subtree ${vSubtree.id}: ${error}`,
        );
        continue;
      }
      totalCost += callCost;
      llmCallCount++;
      this.translateResponse(response, labelToRefId, refsById, llmIssuesByRef);
      this.translateCommentReviews(
        response,
        labelToCommentId,
        commentsById,
        llmModerationsByComment,
      );
    }

    const changedRefs: ProductReference[] = [];
    const perTypeStatusCounts = new Map<string, Map<string, number>>();

    for (const { comment } of subtree.planNodes) {
      for (const ref of comment.productReferences ?? []) {
        const llmIssues = llmIssuesByRef.get(ref.id);
        if (!llmIssues || isEmpty(llmIssues)) continue;

        this.issueResolver.apply(ref, llmIssues);

        for (const issue of llmIssues) {
          let bucket = perTypeStatusCounts.get(issue.type);
          if (!bucket) {
            bucket = new Map();
            perTypeStatusCounts.set(issue.type, bucket);
          }
          bucket.set(issue.status, (bucket.get(issue.status) ?? 0) + 1);
        }

        const llmTypes = new Set(llmIssues.map((i) => i.type));
        const existing = ref.context.issues ?? [];
        const preserved = existing.filter((i) => !llmTypes.has(i.type));
        ref.context.issues = [...preserved, ...llmIssues];
        changedRefs.push(ref);
      }
    }

    if (!isEmpty(changedRefs)) {
      await this.productReferenceRepository.saveAll(changedRefs);
    }

    const changedComments: UserComment[] = [];
    for (const [commentId, moderations] of llmModerationsByComment) {
      const comment = commentsById.get(commentId);
      if (!comment) continue;
      comment.moderations = [...(comment.moderations ?? []), ...moderations];
      changedComments.push(comment);
    }
    if (!isEmpty(changedComments)) {
      await this.userCommentRepository.saveAll(changedComments);
    }

    await this.debugTrace.record({
      threadId: opts.threadId,
      batchId: String(opts.subtreeIndex),
      step: "llm_issue_resolution",
      statusBefore: "extracted",
      statusAfter: "extracted",
      durationMs: Date.now() - phaseStart,
      model: opts.validationModel,
      cost: totalCost,
      costLabel: "llm_validation",
      data: {
        perTypeStatusCounts: Object.fromEntries(
          [...perTypeStatusCounts.entries()].map(([type, statuses]) => [
            type,
            Object.fromEntries(statuses),
          ]),
        ),
        refsChanged: changedRefs.length,
        validationSubtreeCount: validationSubtrees.length,
        llmCallCount,
      } as any,
    });
  }

  private async callLlm(
    rendered: string,
    opts: LlmResolutionOpts,
    subtreeId: string,
    systemPrompt: string,
  ): Promise<{ response: LlmValidationResponse; cost: number }> {
    let tracedCost = 0;
    const chatResponse = await this.aiChat.createChat({
      costLabel: "llm_validation",
      logContext: { subtreeId, threadId: opts.threadId },
      threadId: opts.threadId,
      schema: LLM_VALIDATION_JSON_SCHEMA,
      schemaName: "llm_validation",
      traceCollector: (data) => {
        tracedCost = data.cost;
      },
      model: opts.validationModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildValidationUserPrompt(rendered) },
      ],
      temperature: 1,
      ...(opts.thinking !== undefined && { thinking: opts.thinking }),
      ...(opts.effort !== undefined && { effort: opts.effort }),
    });
    const content = chatResponse.choices[0]?.message?.content ?? "";
    return {
      response: JSON.parse(content) as LlmValidationResponse,
      cost: tracedCost,
    };
  }

  private translateResponse(
    response: LlmValidationResponse,
    labelToRefId: Map<string, string>,
    refsById: Map<string, ProductReference>,
    out: Map<string, ValidationIssue[]>,
  ): void {
    for (const emitted of response.refs) {
      const refId = labelToRefId.get(emitted.refLabel);
      if (!refId) {
        this.logger.warn("LLM emitted unknown ref label, dropping", {
          refLabel: emitted.refLabel,
          cost_label: "llm_validation_unknown_ref_label",
        });
        continue;
      }
      const ref = refsById.get(refId);
      if (!ref) continue;

      const issues: ValidationIssue[] = [];
      for (const e of emitted.issues) {
        const descriptor =
          VALIDATION_ISSUE_TYPES[e.type as keyof typeof VALIDATION_ISSUE_TYPES];
        if (!descriptor || descriptor.authority === "deterministic") {
          this.logger.warn("LLM emitted off-authority issue, dropping", {
            type: e.type,
            refId,
            cost_label: "llm_validation_authority_violation",
          });
          continue;
        }
        const issue = this.buildIssueFromLlm(e, ref);
        if (issue) issues.push(issue);
      }
      if (!isEmpty(issues)) {
        out.set(refId, [...(out.get(refId) ?? []), ...issues]);
      }
    }
  }

  private translateCommentReviews(
    response: LlmValidationResponse,
    labelToCommentId: Map<string, string>,
    commentsById: Map<string, UserComment>,
    out: Map<string, CommentModeration[]>,
  ): void {
    const reviews = response.commentReviews ?? [];
    if (isEmpty(reviews)) return;

    for (const review of reviews) {
      const commentId = labelToCommentId.get(review.commentLabel);
      if (!commentId || !commentsById.has(commentId)) {
        this.logger.warn(
          "LLM emitted comment review for unknown label, dropping",
          {
            commentLabel: review.commentLabel,
            cost_label: "llm_validation_unknown_comment_label",
          },
        );
        continue;
      }
      const moderation: CommentModeration = {
        reviewedBy: "validation_llm",
        source: "validation_llm",
        reviewComment: review.reviewComment,
        createdAt: new Date().toISOString(),
        ...(review.suggestedStatus && {
          suggestedStatus:
            review.suggestedStatus === "in_review"
              ? CommentStatus.IN_REVIEW
              : CommentStatus.DELETED,
        }),
      };
      const bucket = out.get(commentId) ?? [];
      bucket.push(moderation);
      out.set(commentId, bucket);
    }
  }

  private buildIssueFromLlm(
    emitted: LlmEmittedIssue,
    ref: ProductReference,
  ): ValidationIssue | null {
    const common = {
      source: "llm" as const,
      reasoning: emitted.reasoning,
      status: "pending" as const,
    };
    switch (emitted.type) {
      case "wrong_sentiment":
        if (!emitted.suggestedSentiment) return null;
        return buildValidationIssue("wrong_sentiment", {
          ...common,
          currentValue: ref.sentiment,
          suggestedValue: emitted.suggestedSentiment as Sentiment,
        });
      case "wrong_experience":
        if (!emitted.suggestedExperience) return null;
        return buildValidationIssue("wrong_experience", {
          ...common,
          currentValue: ref.experience,
          suggestedValue: emitted.suggestedExperience as ExperienceType,
        });
      case "wrong_depth":
        if (!emitted.suggestedDepth) return null;
        return buildValidationIssue("wrong_depth", {
          ...common,
          currentValue: ref.depth,
          suggestedValue: emitted.suggestedDepth as Depth,
        });
      case "wrong_intent":
        if (!emitted.suggestedIntents) return null;
        return buildValidationIssue("wrong_intent", {
          ...common,
          currentValue: ref.intents ?? [],
          suggestedValue: emitted.suggestedIntents as Intent[],
        });
      case "wrong_product":
        return buildValidationIssue("wrong_product", common);
      case "wrong_quote_attribution":
        return buildValidationIssue("wrong_quote_attribution", {
          ...common,
          quoteId: emitted.quoteId,
        });
      case "boundary_violation":
        return buildValidationIssue("boundary_violation", common);
      case "wrong_quote_quality": {
        if (!emitted.quoteId || !emitted.suggestedQuality) return null;
        const quote = ref.quotes?.find((q) => q.id === emitted.quoteId);
        return buildValidationIssue("wrong_quote_quality", {
          ...common,
          quoteId: emitted.quoteId,
          currentValue: quote?.quality,
          suggestedValue: emitted.suggestedQuality as ContentQuality,
        });
      }
      case "speculative_flag_mismatch":
        if (!emitted.quoteId || emitted.suggestedSpeculative === undefined) {
          return null;
        }
        return buildValidationIssue("speculative_flag_mismatch", {
          ...common,
          quoteId: emitted.quoteId,
          suggestedValue: emitted.suggestedSpeculative,
        });
      default:
        return null;
    }
  }
}
