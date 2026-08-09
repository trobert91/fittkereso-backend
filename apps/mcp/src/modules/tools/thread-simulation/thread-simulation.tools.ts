import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { orderBy } from "lodash";
import {
  CommentNode,
  CommentTree,
  ProductModel,
  ProductReference,
  ProductReferenceCandidate,
  Thread,
  ThreadRepository,
  UserComment,
} from "@ebike-backend/database";
import {
  ThreadContext,
  SubtreeBuilderService,
  Subtree,
  SubtreeBuilderOptions,
  SubtreeMap,
} from "@ebike-backend/thread-processor";
import { nameOf } from "@ebike-backend/utils";

const DEFAULT_BUILDER_OPTIONS: SubtreeBuilderOptions = {
  softBudget: 6000,
  hardBudget: 10000,
  maxPlanNodes: 15,
  maxDepth: 8,
};

@Injectable()
export class ThreadSimulationTools {
  constructor(
    private readonly threadRepo: ThreadRepository,
    private readonly subtreeBuilder: SubtreeBuilderService,
  ) {}

  @Tool({
    name: "get_thread_simulation_data",
    description:
      "Return real-world thread metadata, the full comment tree, and pre-built subtrees for a given thread. Pair with test_ai_chat to simulate any pipeline phase prompt against real Reddit data before wiring them into the pipeline. Read-only — does not touch the DB. Requires a cached comment tree on the thread; does not re-fetch from Reddit.",
    parameters: z.object({
      threadId: z.string().uuid().describe("Thread ID (UUID)."),
      includeBodies: z
        .boolean()
        .default(true)
        .describe(
          "When false, omit comment bodies from tree/subtree output (useful for inspecting structure only).",
        ),
      subtreeIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "When provided, only that subtree is rendered. 0 = OP subtree, 1..N = content subtrees.",
        ),
      nodeLimit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Cap the number of comments in the response. Walks the tree in DFS order and keeps the first N nodes (root always included). Subtrees are filtered to only include surviving nodes.",
        ),
      subtreeLimit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Cap the number of content subtrees returned. The OP subtree is always included and does not count toward this limit. Ignored when subtreeIndex is set.",
        ),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  })
  async getThreadSimulationData(args: {
    threadId: string;
    includeBodies: boolean;
    subtreeIndex?: number;
    nodeLimit?: number;
    subtreeLimit?: number;
  }): Promise<string> {
    const { threadId, includeBodies, subtreeIndex, nodeLimit, subtreeLimit } =
      args;

    const thread = await this.loadThread(threadId);

    const tree = CommentTree.fromObject(thread.commentTree);
    if (!tree || tree.rootNodes.length === 0) {
      return `# Thread Simulation Data\n\nThread ${threadId} has no cached comment tree. Run the thread through the pipeline first so the tree is populated.`;
    }

    const allowedIds = this.computeAllowedIds(tree, nodeLimit);

    const context = this.buildReadOnlyContext(thread);

    const subtreeMap = this.subtreeBuilder.buildSubtrees(tree, context, {
      ...DEFAULT_BUILDER_OPTIONS,
    });

    return this.renderResponse({
      thread,
      tree,
      subtreeMap,
      includeBodies,
      subtreeIndex,
      subtreeLimit,
      allowedIds,
    });
  }

  // ─── Thread load (read-only) ───────────────────────────────────────────────

  private async loadThread(threadId: string): Promise<Thread> {
    const thread = await this.threadRepo.repo
      .createQueryBuilder("thread")
      .addSelect(`thread.${nameOf<Thread>("commentTree")}`)
      .leftJoinAndSelect(`thread.${nameOf<Thread>("categories")}`, "categories")
      .leftJoinAndSelect("categories.productCategory", "productCategory")
      .leftJoinAndSelect(`thread.${nameOf<Thread>("comments")}`, "comments")
      .leftJoinAndSelect(
        `comments.${nameOf<UserComment>("parent")}`,
        "commentParent",
      )
      .leftJoinAndSelect(
        `comments.${nameOf<UserComment>("productReferences")}`,
        "productReferences",
      )
      .leftJoinAndSelect(
        `productReferences.${nameOf<ProductReference>("candidates")}`,
        "candidates",
      )
      .leftJoinAndSelect(
        `candidates.${nameOf<ProductReferenceCandidate>("model")}`,
        "candidateModel",
      )
      .leftJoinAndSelect(
        `candidateModel.${nameOf<ProductModel>("brand")}`,
        "resolvedBrand",
      )
      .leftJoinAndSelect(
        `candidateModel.${nameOf<ProductModel>("productCategory")}`,
        "resolvedProductCategory",
      )
      .where(`thread.${nameOf<Thread>("id")} = :id`, { id: threadId })
      .getOne();
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }
    return thread;
  }

  // ─── Context (read-only, no DB writes) ─────────────────────────────────────

  private buildReadOnlyContext(thread: Thread): ThreadContext {
    const context = new ThreadContext();
    context.subreddit = thread.topic ?? null;
    for (const comment of thread.comments ?? []) {
      context.addComment(comment);
    }
    return context;
  }

  // ─── Node limit ────────────────────────────────────────────────────────────

  private computeAllowedIds(
    tree: CommentTree,
    nodeLimit: number | undefined,
  ): Set<string> | null {
    if (!nodeLimit) return null;

    const allowed = new Set<string>();
    const visit = (node: CommentNode): boolean => {
      if (allowed.size >= nodeLimit) return false;
      allowed.add(node.id);
      for (const child of node.children ?? []) {
        if (!visit(child)) return false;
      }
      return true;
    };
    for (const root of tree.rootNodes) {
      if (!visit(root)) break;
    }
    return allowed;
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  private renderResponse(params: {
    thread: Thread;
    tree: CommentTree;
    subtreeMap: SubtreeMap;
    includeBodies: boolean;
    subtreeIndex?: number;
    subtreeLimit?: number;
    allowedIds: Set<string> | null;
  }): string {
    const L: string[] = [];
    L.push("# Thread Simulation Data");
    L.push("");

    L.push(...this.renderThreadSection(params.thread));
    L.push("");

    if (params.subtreeIndex === undefined) {
      L.push(
        ...this.renderTreeSection(
          params.tree,
          params.thread,
          params.includeBodies,
          params.allowedIds,
        ),
      );
      L.push("");
    }

    L.push(
      ...this.renderSubtreesSection({
        subtreeMap: params.subtreeMap,
        includeBodies: params.includeBodies,
        subtreeIndex: params.subtreeIndex,
        subtreeLimit: params.subtreeLimit,
        allowedIds: params.allowedIds,
      }),
    );

    return L.join("\n");
  }

  private renderThreadSection(thread: Thread): string[] {
    const L: string[] = [];
    L.push("## Thread");
    L.push(`- **id**: ${thread.id}`);
    L.push(`- **title**: ${thread.title ?? ""}`);
    L.push(`- **topic**: ${thread.topic ?? ""}`);
    if (thread.url) L.push(`- **url**: ${thread.url}`);
    L.push(`- **status**: ${thread.status}`);
    if (thread.commentCount !== undefined && thread.commentCount !== null) {
      L.push(`- **commentCount**: ${thread.commentCount}`);
    }

    const orderedCategories = orderBy(thread.categories ?? [], "rank");
    if (orderedCategories.length > 0) {
      L.push("- **categories**:");
      for (const junction of orderedCategories) {
        const confidence = junction.confidence?.toFixed(3) ?? "n/a";
        L.push(
          `  - ${junction.productCategory.slug} (${junction.productCategory.name}) — confidence=${confidence}, rank=${junction.rank}`,
        );
      }
    }
    return L;
  }

  private renderTreeSection(
    tree: CommentTree,
    thread: Thread,
    includeBodies: boolean,
    allowedIds: Set<string> | null,
  ): string[] {
    const commentByExternalId = new Map<string, UserComment>();
    for (const comment of thread.comments ?? []) {
      commentByExternalId.set(comment.externalId, comment);
    }

    const nodeCount = allowedIds
      ? allowedIds.size
      : this.countNodes(tree.rootNodes);

    const L: string[] = [];
    L.push(
      `## Comment Tree (${nodeCount} node${nodeCount === 1 ? "" : "s"}${
        allowedIds ? ", truncated by nodeLimit" : ""
      })`,
    );

    const renderNode = (node: CommentNode, depth: number): void => {
      if (allowedIds && !allowedIds.has(node.id)) return;
      const indent = "  ".repeat(depth);
      const comment = commentByExternalId.get(node.id);
      const status = comment?.status ?? "n/a";
      const authorName = comment?.authorName ?? node.authorName ?? "unknown";
      const bodyText = includeBodies
        ? this.formatBody(comment?.body ?? node.body ?? "")
        : "";
      const bodySuffix = includeBodies && bodyText ? `: ${bodyText}` : "";
      L.push(`${indent}- @${authorName} (${node.id}, ${status})${bodySuffix}`);
      for (const child of node.children ?? []) {
        renderNode(child, depth + 1);
      }
    };

    for (const root of tree.rootNodes) {
      renderNode(root, 0);
    }
    return L;
  }

  private renderSubtreesSection(params: {
    subtreeMap: SubtreeMap;
    includeBodies: boolean;
    subtreeIndex?: number;
    subtreeLimit?: number;
    allowedIds: Set<string> | null;
  }): string[] {
    const {
      subtreeMap,
      includeBodies,
      subtreeIndex,
      subtreeLimit,
      allowedIds,
    } = params;
    const all: Subtree[] = [subtreeMap.opSubtree, ...subtreeMap.subtrees];

    const L: string[] = [];
    const totalContent = subtreeMap.subtrees.length;
    const isLimited =
      subtreeIndex === undefined &&
      subtreeLimit !== undefined &&
      subtreeLimit < totalContent;
    const shownContent = isLimited ? subtreeLimit! : totalContent;
    const headerSuffix = isLimited
      ? `, showing first ${shownContent} of ${totalContent}`
      : "";
    L.push(
      `## Subtrees (${totalContent} content subtree${
        totalContent === 1 ? "" : "s"
      } + OP${headerSuffix})`,
    );

    if (subtreeIndex !== undefined) {
      const selected = all[subtreeIndex];
      if (!selected) {
        L.push(
          `- subtreeIndex=${subtreeIndex} out of range (have ${all.length} total, 0 = OP).`,
        );
        return L;
      }
      L.push(
        ...this.renderSubtree(
          selected,
          subtreeIndex,
          includeBodies,
          allowedIds,
        ),
      );
      return L;
    }

    // OP subtree is always index 0; content subtrees are 1..N. Cap content at subtreeLimit.
    const lastIndex = isLimited ? shownContent : all.length - 1;
    for (let i = 0; i <= lastIndex; i++) {
      const subtree = all[i];
      if (!subtree) continue;
      L.push(...this.renderSubtree(subtree, i, includeBodies, allowedIds));
      L.push("");
    }
    return L;
  }

  private renderSubtree(
    subtree: Subtree,
    index: number,
    includeBodies: boolean,
    allowedIds: Set<string> | null,
  ): string[] {
    const filteredNodes = allowedIds
      ? subtree.nodes.filter((node) => allowedIds.has(node.comment.externalId))
      : subtree.nodes;
    const planCount = filteredNodes.filter((n) => n.nodeType === "PLAN").length;
    const label = subtree.isOpSubtree ? "OP subtree" : `Subtree ${index}`;

    const L: string[] = [];
    L.push(
      `### ${label} (id=${subtree.id}, nodeCount=${filteredNodes.length}, planCount=${planCount})`,
    );
    if (filteredNodes.length === 0) {
      L.push("_No nodes._");
      return L;
    }
    for (const node of filteredNodes) {
      const author = node.comment.authorName ?? "unknown";
      const bodySuffix =
        includeBodies && node.comment.body
          ? `: ${this.formatBody(node.comment.body)}`
          : "";
      L.push(
        `- [${node.nodeType}] depth=${node.depth} @${author} (${node.comment.externalId})${bodySuffix}`,
      );
    }
    return L;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private countNodes(nodes: CommentNode[]): number {
    let count = 0;
    const visit = (node: CommentNode): void => {
      count++;
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of nodes) visit(node);
    return count;
  }

  private formatBody(body: string): string {
    const normalized = body.replace(/\s+/g, " ").trim();
    return normalized;
  }
}
