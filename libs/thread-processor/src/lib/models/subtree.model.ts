import { UserComment } from "@ebike-backend/database";

// ─── Node classification ──────────────────────────────────────────────────────

/**
 * Classification of a comment node within a subtree.
 * - PLAN    — Candidate for per-phase action. Counts toward `maxPlanNodes`.
 *             Per-phase eligibility is decided downstream by projecting the
 *             subtree against the phase's input status set.
 * - CONTEXT — Surrounding context only. Does not count toward `maxPlanNodes`.
 *             Produced by per-phase projection when a node's status doesn't
 *             match the phase input.
 */
export type NodeType = "PLAN" | "CONTEXT";

// ─── SubtreeNode ─────────────────────────────────────────────────────────────

export interface SubtreeNode {
  comment: UserComment;
  nodeType: NodeType;
  /** Depth in the thread tree (OP = 0, direct replies = 1, etc.). */
  depth: number;
}

// ─── Subtree ─────────────────────────────────────────────────────────────────

export interface Subtree {
  id: string;
  isOpSubtree: boolean;
  /** All nodes in DFS order, interleaving PLAN and CONTEXT. */
  nodes: SubtreeNode[];
  /** Filtered view: only PLAN nodes. */
  planNodes: SubtreeNode[];
}

// ─── SubtreeMap ───────────────────────────────────────────────────────────────

export interface SubtreeMap {
  subtrees: Subtree[];
  opSubtree: Subtree;
}

// ─── Budget options ───────────────────────────────────────────────────────────

export interface SubtreeBuilderOptions {
  softBudget: number;
  hardBudget: number;
  maxPlanNodes: number;
  maxDepth: number;
}
