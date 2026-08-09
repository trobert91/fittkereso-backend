import { Injectable } from "@nestjs/common";
import {
  CommentNode,
  CommentStatus,
  CommentTree,
  getIssueLabels,
  resolveMediaContent,
  Thread,
  ThreadRepository,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import { DebugTraceService } from "@ebike-backend/debug";
import { RegistryOptions } from "../models/product-registry.model";
import { ThreadCategoryConfig, ThreadContext } from "../models/thread-context";
import { ProductRegistryService } from "./product-registry.service";
import { isEmpty, orderBy } from "lodash";

// ─── Constants ───────────────────────────────────────────────────────────────

const THREAD_RELATIONS = [
  "categories",
  "categories.productCategory",
  "comments",
  "comments.parent",
  "comments.productReferences",
  "comments.productReferences.candidates",
  "comments.productReferences.candidates.model",
  "comments.productReferences.candidates.model.brand",
  "comments.productReferences.candidates.model.productCategory",
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContextBuildResult {
  thread: Thread;
  context: ThreadContext;
  op: UserComment;
}

export interface ContextBuilderOptions {
  registryOpts: RegistryOptions;
  opSummaryThreshold: number;
  /** Cap categoryConfigs to the top N by rank; downstream prompts see only this slice. */
  maxFocusCategories: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class SubtreeContextBuilderService {
  private readonly logger = new CustomLogger(SubtreeContextBuilderService.name);

  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly commentRepository: UserCommentRepository,
    private readonly productRegistryService: ProductRegistryService,
    private readonly debugTraceService: DebugTraceService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Phase 0: Initialize thread context and recover state from prior runs.
   * Loads the thread, creates missing comment entities, rebuilds in-memory
   * registry and author affinity from already-processed comments.
   */
  async build(
    threadId: string,
    tree: CommentTree,
    opts: ContextBuilderOptions,
  ): Promise<ContextBuildResult> {
    const startTime = Date.now();

    // Step 1: Load thread with full relations
    const thread = await this.threadRepository.findOneOrFail({
      where: { id: threadId },
      relations: [...THREAD_RELATIONS],
    });

    // Step 2: Build base ThreadContext from loaded comments
    const context = new ThreadContext();
    context.subreddit = thread.topic ?? null;
    context.categoryConfigs = this.buildCategoryConfigs(thread).slice(
      0,
      opts.maxFocusCategories,
    );
    if (isEmpty(context.categoryConfigs)) {
      throw new Error(
        `Thread ${threadId} has no identified categories — cannot run extraction without category context.`,
      );
    }
    context.focusCategoryIds = new Set(
      context.categoryConfigs.map((c) => c.categoryId),
    );
    for (const comment of thread.comments) {
      context.addComment(comment);
    }

    // Step 3: getOrCreate new comment entities from tree
    const newComments = await this.getOrCreateNewComments(
      tree,
      thread,
      context,
    );
    for (const c of newComments) {
      context.addComment(c);
    }

    // Step 4: Identify OP comment (the root — no parent) across all comments
    const allComments = [...thread.comments, ...newComments];
    const op = allComments.find((c) => !c.parent);
    if (!op) {
      throw new Error(`Thread ${threadId} has no root comment (OP)`);
    }

    // Step 4b: Copy thread media to OP comment (submission media belongs to OP)
    if (!isEmpty(thread.media) && isEmpty(op.media)) {
      op.media = thread.media;
      await this.commentRepository.repo.update(op.id, { media: op.media });
    }

    // Step 5: Determine opSection (null → Phase 1 must call OPSummarizer).
    // Per-subtree replay (in SubtreeProcessorService) reconstructs the
    // productRegistry and authorProductAffinity from existing references as
    // the subtree loop walks each subtree, so Phase 0 no longer pre-populates.
    context.opSection = this.resolveOpSection(
      thread,
      op,
      opts.opSummaryThreshold,
    );

    // Step 6: Record Phase 0 trace
    await this.recordPhase0Trace(thread, op, newComments, context, startTime);

    return { thread, context, op };
  }

  // ─── Step 4: getOrCreate ───────────────────────────────────────────────────

  private async getOrCreateNewComments(
    tree: CommentTree,
    thread: Thread,
    context: ThreadContext,
  ): Promise<UserComment[]> {
    const existingExternalIds = new Set(
      thread.comments.map((c) => c.externalId),
    );

    const allTreeNodes = this.flattenTree(tree);
    const newNodes = allTreeNodes.filter((n) => !existingExternalIds.has(n.id));

    if (isEmpty(newNodes)) return [];

    const newComments: UserComment[] = [];
    const createdByExternalId = new Map<string, UserComment>();

    for (const node of newNodes) {
      const c = new UserComment();
      c.thread = thread;
      c.externalId = node.id;
      c.url = node.url ?? undefined;
      c.body = node.body;
      c.bodyHtml = node.parentId ? null : (node.bodyHtml ?? null);
      c.authorId = node.authorId ?? undefined;
      c.authorName = node.authorName ?? undefined;
      c.parent = node.parentId
        ? (createdByExternalId.get(node.parentId) ??
          context.getByExternalId(node.parentId) ??
          undefined)
        : undefined;
      c.status = CommentStatus.NEW;
      c.upvotes = node.upvotes ?? 0;
      c.downvotes = node.downvotes ?? 0;
      c.externalCreationTs = node.createdUtc
        ? new Date(node.createdUtc * 1000)
        : undefined;
      const saved = await this.commentRepository.save(c);
      saved.thread = thread;
      createdByExternalId.set(saved.externalId, saved);
      newComments.push(saved);
    }

    return newComments;
  }

  /** DFS flatten all nodes in the CommentTree into a flat array. */
  private flattenTree(tree: CommentTree): CommentNode[] {
    const result: CommentNode[] = [];
    const visit = (node: CommentNode) => {
      result.push(node);
      for (const child of node.children ?? []) {
        visit(child);
      }
    };
    for (const root of tree.rootNodes) {
      visit(root);
    }
    return result;
  }

  // ─── OP Section Resolution ────────────────────────────────────────────────

  /**
   * Determine the OP section text for prompts.
   * Returns null if the OP body is too long and no summary exists yet
   * (Phase 1 will call OPSummarizerService to generate one).
   */
  private resolveOpSection(
    thread: Thread,
    op: UserComment,
    threshold: number,
  ): string | null {
    const summary = thread.opSummary;
    const mediaContent = resolveMediaContent(op.media);

    if (summary && summary.length > 0) {
      const enriched = mediaContent ? `${summary}\n${mediaContent}` : summary;
      return this.formatOpSection(enriched, op.authorName ?? "[OP]");
    }

    const body = mediaContent ? `${op.body}\n${mediaContent}` : op.body;

    if (body.length <= threshold) {
      return this.formatOpSection(body, op.authorName ?? "[OP]");
    }
    // Body too long, no summary yet → Phase 1 will generate
    return null;
  }

  private formatOpSection(text: string, authorName: string): string {
    return `@${authorName}: "${text}"`;
  }

  // ─── Category Config ─────────────────────────────────────────────────────

  private buildCategoryConfigs(thread: Thread): ThreadCategoryConfig[] {
    return orderBy(thread.categories ?? [], "rank").map((junction) => {
      const config = this.categoryConfigService.getConfig(
        junction.productCategory.slug,
      );
      return {
        categoryId: junction.productCategory.id,
        categoryName: junction.productCategory.name,
        confidence: junction.confidence,
        promptConfig: config?.promptConfig ?? {},
        features: config?.features ?? [],
        useCases: config?.useCases ?? [],
        issues: getIssueLabels(config),
      };
    });
  }

  // ─── Step 9: Trace Recording ───────────────────────────────────────────────

  private async recordPhase0Trace(
    thread: Thread,
    _op: UserComment,
    newComments: UserComment[],
    _context: ThreadContext,
    startTime: number,
  ): Promise<void> {
    try {
      await this.debugTraceService.record({
        threadId: thread.id,
        commentId: thread.id,
        step: "phase_0_recovery",
        statusBefore: "N/A",
        statusAfter: "N/A",
        durationMs: Date.now() - startTime,
        data: {
          summary: `Phase 0: ${newComments.length} new comments created. Registry/affinity will be rebuilt subtree-by-subtree.`,
          batchInit: {
            // Phase 0 no longer pre-populates: per-subtree replay handles the
            // registry buildup. Emit zeroes for legacy fields.
            processedComments: 0,
            newComments: newComments.length,
            orphansRecovered: 0,
            productsLoaded: 0,
          },
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to record Phase 0 trace: ${err}`);
    }
  }
}
