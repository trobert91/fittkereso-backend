import {
  CommentNode,
  CommentStatus,
  CommentTree,
  UserComment,
} from "@ebike-backend/database";
import { ThreadContext } from "../models/thread-context";
import { SubtreeBuilderOptions } from "../models/subtree.model";
import { SubtreeBuilderService } from "./subtree-builder.service";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeComment(
  externalId: string,
  status: CommentStatus = CommentStatus.NEW,
): UserComment {
  const comment = new UserComment();
  comment.externalId = externalId;
  comment.body = `Comment ${externalId}`;
  comment.status = status;
  return comment;
}

function makeTreeNode(id: string, children: CommentNode[] = []): CommentNode {
  return {
    id,
    authorId: `author-${id}`,
    authorName: `Author ${id}`,
    url: "",
    body: `Comment ${id}`,
    bodyHtml: null,
    upvotes: 1,
    downvotes: 0,
    createdUtc: Date.now(),
    children,
  };
}

/**
 * Build a linear chain: OP → d1 → d2 → ... → dN
 */
function buildLinearChain(
  depth: number,
  statusByDepth: Record<number, CommentStatus> = {},
): { tree: CommentTree; comments: UserComment[] } {
  const comments: UserComment[] = [];

  for (let depthIndex = 0; depthIndex <= depth; depthIndex++) {
    const status = statusByDepth[depthIndex] ?? CommentStatus.NEW;
    const comment = makeComment(`c${depthIndex}`, status);
    if (depthIndex > 0) comment.parent = comments[depthIndex - 1];
    comments.push(comment);
  }

  let currentTreeNode = makeTreeNode(`c${depth}`);
  for (let depthIndex = depth - 1; depthIndex >= 0; depthIndex--) {
    currentTreeNode = makeTreeNode(`c${depthIndex}`, [currentTreeNode]);
  }

  const tree = new CommentTree("reddit");
  tree.addRootNode("c0", currentTreeNode);

  const registerNodes = (node: CommentNode): void => {
    tree.addNode(node.id, node);
    node.children.forEach(registerNodes);
  };
  registerNodes(currentTreeNode);

  return { tree, comments };
}

function buildContext(comments: UserComment[]): ThreadContext {
  const context = new ThreadContext();
  for (const comment of comments) {
    context.addComment(comment);
  }
  return context;
}

const DEFAULT_OPTIONS: SubtreeBuilderOptions = {
  softBudget: 100_000,
  hardBudget: 150_000,
  maxPlanNodes: 50,
  maxDepth: 6,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SubtreeBuilderService", () => {
  let service: SubtreeBuilderService;

  beforeEach(() => {
    service = new SubtreeBuilderService();
  });

  it("treats every comment as a PLAN node regardless of status", () => {
    const { tree, comments } = buildLinearChain(5, {
      0: CommentStatus.NEW,
      1: CommentStatus.IDENTIFIED,
      2: CommentStatus.VALIDATED,
      3: CommentStatus.EXTRACTED,
      4: CommentStatus.LABELED,
      5: CommentStatus.APPROVED,
    });

    const context = buildContext(comments);
    const result = service.buildSubtrees(tree, context, DEFAULT_OPTIONS);

    const allNodes = [
      ...result.opSubtree.nodes,
      ...result.subtrees.flatMap((s) => s.nodes),
    ];
    const externalIds = allNodes.map((n) => n.comment.externalId).sort();

    expect(externalIds).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"].sort());

    for (const node of allNodes) {
      expect(node.nodeType).toBe("PLAN");
    }
  });

  it("produces an OP subtree containing the OP comment", () => {
    const { tree, comments } = buildLinearChain(2);
    const context = buildContext(comments);

    const result = service.buildSubtrees(tree, context, DEFAULT_OPTIONS);

    expect(result.opSubtree.isOpSubtree).toBe(true);
    expect(result.opSubtree.planNodes).toHaveLength(1);
    expect(result.opSubtree.planNodes[0].comment.externalId).toBe("c0");
  });

  it("respects maxPlanNodes when packing branches", () => {
    const { tree, comments } = buildLinearChain(10);
    const context = buildContext(comments);

    const result = service.buildSubtrees(tree, context, {
      ...DEFAULT_OPTIONS,
      maxPlanNodes: 3,
      maxDepth: 10,
    });

    for (const subtree of result.subtrees) {
      expect(subtree.planNodes.length).toBeLessThanOrEqual(3);
    }
  });

  it("keeps every comment in some subtree (leftover pass)", () => {
    const { tree, comments } = buildLinearChain(8);
    const context = buildContext(comments);

    const result = service.buildSubtrees(tree, context, {
      ...DEFAULT_OPTIONS,
      maxPlanNodes: 2,
      maxDepth: 8,
    });

    const allCovered = new Set<string>();
    for (const node of result.opSubtree.nodes) {
      allCovered.add(node.comment.externalId);
    }
    for (const subtree of result.subtrees) {
      for (const node of subtree.nodes) {
        allCovered.add(node.comment.externalId);
      }
    }

    for (const comment of comments) {
      expect(allCovered.has(comment.externalId)).toBe(true);
    }
  });

  it("does not duplicate comments across subtrees", () => {
    const { tree, comments } = buildLinearChain(6);
    const context = buildContext(comments);

    const result = service.buildSubtrees(tree, context, {
      ...DEFAULT_OPTIONS,
      maxPlanNodes: 2,
      maxDepth: 6,
    });

    const allIds: string[] = [];
    for (const subtree of [result.opSubtree, ...result.subtrees]) {
      for (const node of subtree.nodes) {
        allIds.push(node.comment.externalId);
      }
    }

    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
