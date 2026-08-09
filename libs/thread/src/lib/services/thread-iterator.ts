import {
  CommentNode,
  CommentStatus,
  CommentTree,
  UserComment,
} from "@ebike-backend/database";
import { chunk, isEmpty } from "lodash";

export type NodeVisitor = (
  nodeIndex: number,
  node: CommentNode,
  parent?: CommentNode,
) => Promise<UserComment | undefined>;

export class ThreadIterator {
  private nodeIndex = 0;
  private readonly runParallel: boolean;

  constructor(runParallel = false) {
    this.runParallel = runParallel;
  }

  /**
   * Walk the tree in depth-first order.
   * If runParallel = true, processes child nodes in parallel batches of 5.
   */
  async iterate({
    tree,
    visitor,
    stopIfNotApproved,
  }: {
    tree: CommentTree;
    visitor: NodeVisitor;
    stopIfNotApproved: boolean;
  }): Promise<void> {
    for (const root of tree.rootNodes) {
      await this.iterateNode(root, undefined, visitor, stopIfNotApproved);
    }
  }

  private async iterateNode(
    node: CommentNode,
    parent: CommentNode | undefined,
    visitor: NodeVisitor,
    stopIfNotApproved = false,
  ): Promise<UserComment | undefined> {
    const result = await visitor(this.nodeIndex++, node, parent);

    if (isEmpty(node.children)) return result;

    // allow processing children only if current node is approved
    if (stopIfNotApproved && result?.status !== CommentStatus.APPROVED) {
      return result;
    }

    if (this.runParallel) {
      const chunks = chunk(node.children, 5);
      for (const batch of chunks) {
        await Promise.all(
          batch.map((child) =>
            this.iterateNode(child, node, visitor, stopIfNotApproved),
          ),
        );
      }
    } else {
      for (const child of node.children) {
        await this.iterateNode(child, node, visitor, stopIfNotApproved);
      }
    }

    return result;
  }
}
