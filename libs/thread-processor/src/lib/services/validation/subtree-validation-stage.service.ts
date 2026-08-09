import { Injectable } from "@nestjs/common";
import {
  CommentStatus,
  CommentTree,
  UserCommentRepository,
} from "@ebike-backend/database";
import { DebugTraceService } from "@ebike-backend/debug";
import { isEmpty } from "lodash";
import { Subtree } from "../../models/subtree.model";
import { ThreadContext } from "../../models/thread-context";
import { SubtreeIssueResolutionService } from "./subtree-issue-resolution.service";
import { SubtreeLlmIssueResolutionService } from "./subtree-llm-issue-resolution.service";

export interface ValidationStageOpts {
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
export class SubtreeValidationStageService {
  constructor(
    private readonly deterministic: SubtreeIssueResolutionService,
    private readonly llm: SubtreeLlmIssueResolutionService,
    private readonly commentRepository: UserCommentRepository,
    private readonly debugTrace: DebugTraceService,
  ) {}

  async validate(
    subtree: Subtree,
    tree: CommentTree,
    context: ThreadContext,
    opts: ValidationStageOpts,
  ): Promise<void> {
    const phaseStart = Date.now();

    // Restrict to PLAN nodes that came in at LABELED. Comments at any other
    // status are out of scope — the resolver/LLM rounds operate on the
    // already-filtered subtree below.
    const eligiblePlanNodes = subtree.planNodes.filter(
      (n) => n.comment.status === CommentStatus.LABELED,
    );
    if (isEmpty(eligiblePlanNodes)) return;

    const scopedSubtree: Subtree = { ...subtree, planNodes: eligiblePlanNodes };

    await this.deterministic.resolve(scopedSubtree, context, {
      threadId: opts.threadId,
      subtreeIndex: opts.subtreeIndex,
    });

    await this.llm.resolve(scopedSubtree, tree, context, opts);

    const changedComments = eligiblePlanNodes.map(({ comment }) => comment);
    for (const comment of changedComments) {
      comment.status = CommentStatus.VALIDATED;
    }
    if (!isEmpty(changedComments)) {
      await this.commentRepository.saveAll(changedComments);
    }

    await this.debugTrace.record({
      threadId: opts.threadId,
      batchId: String(opts.subtreeIndex),
      step: "validation_stage",
      statusBefore: "labeled",
      statusAfter: "validated",
      durationMs: Date.now() - phaseStart,
      data: {
        commentsValidated: changedComments.length,
      } as any,
    });
  }
}
