import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  CommentTree,
  CommentNode,
  getPrimaryModel,
  UserComment,
} from "@ebike-backend/database";
import {
  Subtree,
  SubtreeBuilderOptions,
  SubtreeMap,
  SubtreeNode,
} from "../models/subtree.model";
import { ThreadContext } from "../models/thread-context";

// ─── Internal working types (not exported) ───────────────────────────────────

interface TraversedNode {
  comment: UserComment;
  depth: number;
  parentExternalId: string | null;
}

interface BranchInfo {
  dfsNodes: TraversedNode[];
  planCount: number;
  cost: number;
  deeperNodes: TraversedNode[];
  hasDeeperPlanNodes: boolean;
}

interface SubtreeInProgress {
  id: string;
  addedBranches: BranchInfo[];
  nodes: SubtreeNode[];
  planCount: number;
  totalCost: number;
}

@Injectable()
export class SubtreeBuilderService {
  // ─── Public API ──────────────────────────────────────────────────────────────

  buildSubtrees(
    tree: CommentTree,
    context: ThreadContext,
    options: SubtreeBuilderOptions,
  ): SubtreeMap {
    const opTreeNode = tree.rootNodes[0];
    if (!opTreeNode)
      return { subtrees: [], opSubtree: this.emptySubtree(true) };

    const opSubtree = this.buildOPSubtree(opTreeNode, context);

    const branches = opTreeNode.children.map((child) =>
      this.computeBranchInfo(child, context, 1, options.maxDepth),
    );

    const contentSubtrees = this.greedyPackBranches(branches, context, options);

    // Collect assigned IDs from all subtrees so far
    const assignedCommentIds = new Set<string>();
    for (const s of [opSubtree, ...contentSubtrees]) {
      for (const n of s.nodes) assignedCommentIds.add(n.comment.externalId);
    }

    // Leftover pass — comments excluded by budget/comment caps
    const allComments = this.collectAllComments(tree, context);
    const leftovers = allComments.filter(
      (c) => !assignedCommentIds.has(c.externalId),
    );

    let leftoverSubtrees: Subtree[] = [];
    if (leftovers.length > 0) {
      leftoverSubtrees = this.buildLeftoverSubtrees(
        leftovers,
        context,
        options,
        assignedCommentIds,
      );
    }

    // Finalize OP subtree separately from content subtrees
    const finalizedOpSubtree = this.finalizeSubtree(opSubtree);

    // Combine content + leftovers, finalize, drop empty subtrees.
    const subtrees = [...contentSubtrees, ...leftoverSubtrees]
      .map((s) => this.finalizeSubtree(s))
      .filter((s) => s.nodes.length > 0);

    return {
      subtrees,
      opSubtree: finalizedOpSubtree,
    };
  }

  /**
   * Builds the [products: ...] annotation string for a CONTEXT node.
   * Called at prompt-render time, not during subtree building.
   */
  buildContextProductAnnotation(comment: UserComment): string | undefined {
    const enabledRefs = (comment.productReferences ?? []).filter(
      (r) => r.enabled,
    );
    if (enabledRefs.length === 0) return undefined;

    const names = enabledRefs.map((ref) => {
      const resolved = getPrimaryModel(ref);
      if (resolved?.displayName) return resolved.displayName;
      const brand = ref.context?.identification?.brand ?? "";
      const model = ref.context?.identification?.model ?? "";
      return `${brand} ${model}`.trim() || "Unknown";
    });

    return `[products: ${names.join(", ")}]`;
  }

  // ─── Private: OP subtree ─────────────────────────────────────────────────────

  private buildOPSubtree(
    opTreeNode: CommentNode,
    context: ThreadContext,
  ): Subtree {
    const opComment = context.getByExternalId(opTreeNode.id);
    if (!opComment) return this.emptySubtree(true);

    const node: SubtreeNode = {
      comment: opComment,
      nodeType: "PLAN",
      depth: 0,
    };

    return {
      id: randomUUID(),
      isOpSubtree: true,
      nodes: [node],
      planNodes: [node],
    };
  }

  // ─── Private: Branch traversal ───────────────────────────────────────────────

  private computeBranchInfo(
    treeNode: CommentNode,
    context: ThreadContext,
    depth: number,
    maxDepth: number,
  ): BranchInfo {
    const dfsNodes: TraversedNode[] = [];
    const deeperNodes: TraversedNode[] = [];

    const traverse = (
      node: CommentNode,
      d: number,
      parentExtId: string | null,
    ) => {
      const comment = context.getByExternalId(node.id);
      if (!comment) return;

      const traversed: TraversedNode = {
        comment,
        depth: d,
        parentExternalId: parentExtId,
      };

      if (d <= maxDepth) {
        dfsNodes.push(traversed);
      } else {
        deeperNodes.push(traversed);
      }

      for (const child of node.children) {
        traverse(child, d + 1, comment.externalId);
      }
    };

    traverse(treeNode, depth, null);

    const cost = dfsNodes.reduce(
      (sum, n) => sum + this.estimateNodeCost(n.comment),
      0,
    );

    return {
      dfsNodes,
      planCount: dfsNodes.length,
      cost,
      deeperNodes,
      hasDeeperPlanNodes: deeperNodes.length > 0,
    };
  }

  // ─── Private: Cost ───────────────────────────────────────────────────────────

  private estimateNodeCost(comment: UserComment): number {
    const bodyLength = comment.body?.length ?? 0;
    const refCount =
      comment.productReferences?.filter((r) => r.enabled)?.length ?? 0;
    return bodyLength + 80 + refCount * 130;
  }

  // ─── Private: Greedy packing ─────────────────────────────────────────────────

  private greedyPackBranches(
    branches: BranchInfo[],
    context: ThreadContext,
    opts: SubtreeBuilderOptions,
  ): Subtree[] {
    const { softBudget, hardBudget, maxPlanNodes } = opts;
    const subtrees: Subtree[] = [];
    let current = this.newSubtreeInProgress();

    for (const branch of branches) {
      const fitsInCurrent =
        current.totalCost + branch.cost <= softBudget &&
        current.planCount + branch.planCount <= maxPlanNodes;

      if (fitsInCurrent) {
        this.addBranchNodes(current, branch.dfsNodes);
        current.addedBranches.push(branch);
      } else {
        // Flush current subtree
        this.extendDepth(current, softBudget, maxPlanNodes);
        if (current.planCount > 0 || current.nodes.length > 0) {
          subtrees.push(this.toSubtree(current));
        }

        current = this.newSubtreeInProgress();

        if (branch.cost <= softBudget && branch.planCount <= maxPlanNodes) {
          this.addBranchNodes(current, branch.dfsNodes);
          current.addedBranches.push(branch);
        } else {
          this.addBranchWithHardCap(current, branch, hardBudget, maxPlanNodes);
        }
      }
    }

    // Finalize last subtree
    this.extendDepth(current, softBudget, maxPlanNodes);
    if (current.planCount > 0 || current.nodes.length > 0) {
      subtrees.push(this.toSubtree(current));
    }

    return subtrees;
  }

  // ─── Private: Node inclusion ─────────────────────────────────────────────────

  private addBranchNodes(
    subtree: SubtreeInProgress,
    dfsNodes: TraversedNode[],
  ): void {
    for (const tn of dfsNodes) {
      const node: SubtreeNode = {
        comment: tn.comment,
        nodeType: "PLAN",
        depth: tn.depth,
      };

      subtree.nodes.push(node);
      subtree.totalCost += this.estimateNodeCost(tn.comment);
      subtree.planCount++;
    }
  }

  private addBranchWithHardCap(
    subtree: SubtreeInProgress,
    branch: BranchInfo,
    hardBudget: number,
    maxPlanNodes: number,
  ): void {
    subtree.addedBranches.push(branch);

    for (const tn of branch.dfsNodes) {
      const cost = this.estimateNodeCost(tn.comment);

      if (subtree.totalCost + cost > hardBudget) break;
      if (subtree.planCount >= maxPlanNodes) break;

      subtree.nodes.push({
        comment: tn.comment,
        nodeType: "PLAN",
        depth: tn.depth,
      });
      subtree.totalCost += cost;
      subtree.planCount++;
    }
  }

  // ─── Private: Depth extension ────────────────────────────────────────────────

  private extendDepth(
    subtree: SubtreeInProgress,
    softBudget: number,
    maxPlanNodes: number,
  ): void {
    let remaining = softBudget - subtree.totalCost;
    let remainingSlots = maxPlanNodes - subtree.planCount;

    if (remaining <= 0 || remainingSlots <= 0) return;

    // Collect ALL deeper nodes from branches that have any, preserving DFS order
    const allDeeperNodes: TraversedNode[] = [];
    for (const branch of subtree.addedBranches) {
      if (branch.hasDeeperPlanNodes) {
        allDeeperNodes.push(...branch.deeperNodes);
      }
    }

    // Select which nodes fit within budget/slots (depth-first priority)
    const sortedDeeper = [...allDeeperNodes].sort((a, b) => a.depth - b.depth);

    const selectedIds = new Set<string>();
    for (const tn of sortedDeeper) {
      const cost = this.estimateNodeCost(tn.comment);
      if (remaining < cost || remainingSlots <= 0) break;

      selectedIds.add(tn.comment.externalId);
      remaining -= cost;
      remainingSlots--;
    }

    if (selectedIds.size === 0) return;

    // Deduplicate against nodes already in the subtree
    const existingIds = new Set(
      subtree.nodes.map((node) => node.comment.externalId),
    );

    // Append in DFS order (allDeeperNodes preserves traverse order)
    for (const tn of allDeeperNodes) {
      if (!selectedIds.has(tn.comment.externalId)) continue;
      if (existingIds.has(tn.comment.externalId)) continue;

      const cost = this.estimateNodeCost(tn.comment);

      subtree.nodes.push({
        comment: tn.comment,
        nodeType: "PLAN",
        depth: tn.depth,
      });
      subtree.totalCost += cost;
      subtree.planCount++;
      existingIds.add(tn.comment.externalId);
    }
  }

  // ─── Private: Leftovers ──────────────────────────────────────────────────────

  private buildLeftoverSubtrees(
    leftovers: UserComment[],
    context: ThreadContext,
    opts: SubtreeBuilderOptions,
    assignedCommentIds: Set<string>,
  ): Subtree[] {
    const subtrees: Subtree[] = [];
    let current = this.newSubtreeInProgress();

    for (const comment of leftovers) {
      const allAncestors = context.getAncestors(comment);
      const planDepth = allAncestors.length;
      // Ancestors only get pulled in as CONTEXT if they aren't already in
      // some other subtree; otherwise the same comment would appear in
      // multiple subtrees and downstream "all-subtrees" iteration would
      // double-count it.
      const ancestors = allAncestors
        .slice(0, 2)
        .filter((a) => !assignedCommentIds.has(a.externalId));
      const contextCost = ancestors.reduce(
        (s, a) => s + this.estimateNodeCost(a),
        0,
      );
      const planCost = this.estimateNodeCost(comment);
      const totalCost = contextCost + planCost;

      const fits =
        current.totalCost + totalCost <= opts.softBudget &&
        current.planCount + 1 <= opts.maxPlanNodes;

      if (!fits && current.planCount > 0) {
        subtrees.push(this.toSubtree(current));
        current = this.newSubtreeInProgress();
      }

      // Add ancestor nodes as CONTEXT — they anchor the leftover comment in
      // the conversation tree and don't count toward the per-subtree PLAN
      // budget here. (For the main bin-packing path, every node is uniformly
      // PLAN; this leftover path is a narrow special case.)
      for (let i = 0; i < ancestors.length; i++) {
        const ancestor = ancestors[i];
        if (assignedCommentIds.has(ancestor.externalId)) continue;
        const cnCost = this.estimateNodeCost(ancestor);
        if (current.totalCost + cnCost > opts.hardBudget) continue;
        current.nodes.push({
          comment: ancestor,
          nodeType: "CONTEXT",
          depth: planDepth - 1 - i,
        });
        current.totalCost += cnCost;
        assignedCommentIds.add(ancestor.externalId);
      }

      // Add PLAN node (always included)
      current.nodes.push({ comment, nodeType: "PLAN", depth: planDepth });
      current.totalCost += planCost;
      current.planCount++;
      assignedCommentIds.add(comment.externalId);
    }

    if (current.planCount > 0) subtrees.push(this.toSubtree(current));
    return subtrees;
  }

  // ─── Private: Utilities ──────────────────────────────────────────────────────

  private collectAllComments(
    tree: CommentTree,
    context: ThreadContext,
  ): UserComment[] {
    const result: UserComment[] = [];
    const traverse = (node: CommentNode) => {
      const comment = context.getByExternalId(node.id);
      if (comment) result.push(comment);
      node.children.forEach(traverse);
    };
    tree.rootNodes.forEach(traverse);
    return result;
  }

  private finalizeSubtree(subtree: Subtree): Subtree {
    const planNodes = subtree.nodes.filter((n) => n.nodeType === "PLAN");
    return { ...subtree, planNodes };
  }

  private newSubtreeInProgress(): SubtreeInProgress {
    return {
      id: randomUUID(),
      addedBranches: [],
      nodes: [],
      planCount: 0,
      totalCost: 0,
    };
  }

  private toSubtree(sip: SubtreeInProgress): Subtree {
    return {
      id: sip.id,
      isOpSubtree: false,
      nodes: sip.nodes,
      planNodes: [],
    };
  }

  private emptySubtree(isOp: boolean): Subtree {
    return {
      id: randomUUID(),
      isOpSubtree: isOp,
      nodes: [],
      planNodes: [],
    };
  }
}
