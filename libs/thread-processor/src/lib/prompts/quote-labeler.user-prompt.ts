import { ProductReference } from "@ebike-backend/database";
import { Subtree } from "../models/subtree.model";

/**
 * Collect every ProductReference that has at least one extracted quote,
 * across all PLAN nodes in DFS order. This is the input set for labeling
 * — refs without quotes have nothing to label.
 */
export function collectExtractedRefs(subtree: Subtree): ProductReference[] {
  const refs: ProductReference[] = [];
  for (const node of subtree.planNodes) {
    for (const ref of node.comment.productReferences ?? []) {
      if (ref.quotes?.length) {
        refs.push(ref);
      }
    }
  }
  return refs;
}

/**
 * Map comment.id → letter label (A, B, C, …) for every PLAN node in DFS
 * order. Used by the labeling prompt and by `applyLabels` to reconstruct
 * the productId from (commentLabel, productIndex).
 */
export function buildCommentLabelMap(subtree: Subtree): Map<string, string> {
  const commentLabelMap = new Map<string, string>();
  let counter = 0;
  for (const node of subtree.planNodes) {
    if (!commentLabelMap.has(node.comment.id)) {
      commentLabelMap.set(node.comment.id, String.fromCharCode(65 + counter));
      counter++;
    }
  }
  return commentLabelMap;
}
