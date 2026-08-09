import { Inject, Injectable } from "@nestjs/common";
import {
  CommentContext,
  IssueLabelConfig,
  ProductReference,
  ProductReferenceRepository,
  UserComment,
  UserCommentRepository,
  ValidationIssue,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { DebugTraceService } from "@ebike-backend/debug";
import { normalize } from "@ebike-backend/utils";
import { isEmpty } from "lodash";
import {
  DetectionContext,
  ISSUE_DETECTORS,
  IssueDetector,
} from "../../interfaces/issue-detector.interface";
import { buildValidationIssue, IssueResolver, VALIDATION_ISSUE_TYPES } from ".";
import { Subtree } from "../../models/subtree.model";
import { ThreadContext } from "../../models/thread-context";

export interface IssueResolutionOpts {
  threadId: string;
  subtreeIndex: number;
}

@Injectable()
export class SubtreeIssueResolutionService {
  private readonly logger = new CustomLogger(
    SubtreeIssueResolutionService.name,
  );

  constructor(
    @Inject(ISSUE_DETECTORS)
    private readonly detectors: IssueDetector[],
    private readonly issueResolver: IssueResolver,
    private readonly productReferenceRepository: ProductReferenceRepository,
    private readonly commentRepository: UserCommentRepository,
    private readonly debugTrace: DebugTraceService,
  ) {}

  async resolve(
    subtree: Subtree,
    context: ThreadContext,
    opts: IssueResolutionOpts,
  ): Promise<void> {
    const phaseStart = Date.now();
    const changedRefs: ProductReference[] = [];
    const changedComments: UserComment[] = [];
    const perTypeStatusCounts = new Map<string, Map<string, number>>();
    const perDetectorEmitCounts = new Map<string, number>();

    for (const { comment } of subtree.planNodes) {
      const issueLabelsIndex = this.buildIssueLabelsIndex(
        context.categoryConfigs?.[0]?.issues ?? [],
      );
      const commentBody = comment.body ?? "";
      const ctx: DetectionContext = {
        commentBody,
        comment,
        issueLabelsIndex,
      };

      const refs = comment.productReferences ?? [];
      const issuesByRefIndex: ValidationIssue[][] = [];
      for (let refIndex = 0; refIndex < refs.length; refIndex++) {
        const ref = refs[refIndex];
        const refIssues: ValidationIssue[] = [];

        for (const detector of this.detectors) {
          const found = detector.detect(ref, ctx).filter((issue) => {
            const descriptor = VALIDATION_ISSUE_TYPES[issue.type];
            if (!descriptor || descriptor.authority === "llm") {
              this.logger.warn(
                "Deterministic detector emitted off-authority issue, dropping",
                {
                  detector: detector.constructor.name,
                  type: issue.type,
                },
              );
              return false;
            }
            return true;
          });
          if (!isEmpty(found)) {
            perDetectorEmitCounts.set(
              detector.constructor.name,
              (perDetectorEmitCounts.get(detector.constructor.name) ?? 0) +
                found.length,
            );
            refIssues.push(...found);
          }
        }

        issuesByRefIndex.push(refIssues);
      }

      // Per-comment duplicate-model check: if any catalog product model
      // appears in 2+ refs' candidate sets on this comment, emit ONE
      // `duplicate_model` issue at the COMMENT level (it spans multiple refs
      // so attaching it to one would be misleading). The payload enumerates
      // every involved ref and every shared model so reviewers see the whole
      // overlap cluster from a single record.
      const modelIdToRefIndexes = new Map<string, number[]>();
      for (let refIndex = 0; refIndex < refs.length; refIndex++) {
        for (const candidate of refs[refIndex].candidates ?? []) {
          const modelId = candidate.model?.id;
          if (!modelId) continue;
          const indexes = modelIdToRefIndexes.get(modelId) ?? [];
          if (!indexes.includes(refIndex)) indexes.push(refIndex);
          modelIdToRefIndexes.set(modelId, indexes);
        }
      }
      const sharedModelIds: string[] = [];
      const involvedRefIndexes = new Set<number>();
      for (const [modelId, indexes] of modelIdToRefIndexes) {
        if (indexes.length < 2) continue;
        sharedModelIds.push(modelId);
        for (const index of indexes) involvedRefIndexes.add(index);
      }
      const commentIssues: ValidationIssue[] = [];
      if (sharedModelIds.length > 0) {
        const sortedIndexes = [...involvedRefIndexes].sort((a, b) => a - b);
        const duplicateIssue = buildValidationIssue("duplicate_model", {
          source: "deterministic",
          status: "pending",
          refIds: sortedIndexes.map((index) => refs[index].id),
          sharedModelIds,
        });
        commentIssues.push(duplicateIssue);
        let bucket = perTypeStatusCounts.get(duplicateIssue.type);
        if (!bucket) {
          bucket = new Map();
          perTypeStatusCounts.set(duplicateIssue.type, bucket);
        }
        bucket.set(
          duplicateIssue.status,
          (bucket.get(duplicateIssue.status) ?? 0) + 1,
        );
        perDetectorEmitCounts.set(
          "DuplicateModelCommentPass",
          (perDetectorEmitCounts.get("DuplicateModelCommentPass") ?? 0) + 1,
        );
      }

      // Always rewrite `comment.context.issues` so stale entries from a prior
      // reprocess run get cleared even when this round emits nothing.
      if (!comment.context) {
        comment.context = new CommentContext({ commentBody });
      }
      comment.context.issues = commentIssues;
      changedComments.push(comment);

      for (let refIndex = 0; refIndex < refs.length; refIndex++) {
        const ref = refs[refIndex];
        const refIssues = issuesByRefIndex[refIndex];

        // Always replace ref.context.issues — clears stale entries from a prior
        // reprocess run even when this round emits nothing for the ref.
        if (!isEmpty(refIssues)) {
          this.issueResolver.apply(ref, refIssues);

          for (const issue of refIssues) {
            if (issue.status === "pending") {
              this.logger.warn(
                "pipeline_invariant_violation: issue still pending after resolver",
                { type: issue.type, refId: ref.id },
              );
            }
            let bucket = perTypeStatusCounts.get(issue.type);
            if (!bucket) {
              bucket = new Map();
              perTypeStatusCounts.set(issue.type, bucket);
            }
            bucket.set(issue.status, (bucket.get(issue.status) ?? 0) + 1);
          }
        }

        ref.context.issues = refIssues;
        changedRefs.push(ref);
      }
    }

    if (!isEmpty(changedRefs)) {
      await this.productReferenceRepository.saveAll(changedRefs);
    }
    if (!isEmpty(changedComments)) {
      await this.commentRepository.saveAll(changedComments);
    }

    await this.debugTrace.record({
      threadId: opts.threadId,
      batchId: String(opts.subtreeIndex),
      step: "issue_resolution",
      statusBefore: "extracted",
      statusAfter: "extracted",
      durationMs: Date.now() - phaseStart,
      data: {
        perDetectorEmitCounts: Object.fromEntries(perDetectorEmitCounts),
        perTypeStatusCounts: Object.fromEntries(
          [...perTypeStatusCounts.entries()].map(([type, statuses]) => [
            type,
            Object.fromEntries(statuses),
          ]),
        ),
        refsChanged: changedRefs.length,
      } as any,
    });
  }

  private buildIssueLabelsIndex(
    labels: IssueLabelConfig[],
  ): Map<string, IssueLabelConfig> {
    const index = new Map<string, IssueLabelConfig>();
    for (const label of labels) {
      index.set(normalize(label.label), label);
    }
    return index;
  }
}
