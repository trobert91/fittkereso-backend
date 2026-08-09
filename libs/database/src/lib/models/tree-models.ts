import { flatMap, isEmpty } from 'lodash';

export class CommentTree {
  public type: 'reddit' | 'youtube';
  public rootNodes: CommentNode[];

  private map: Record<string, CommentNode> = {};

  constructor(type: 'reddit' | 'youtube', rootNodes?: CommentNode[]) {
    this.type = type;
    this.rootNodes = [];
    rootNodes?.forEach((node) => this.addRootNode(node.id, node));
  }

  addRootNode(id: string, node: CommentNode): void {
    this.rootNodes.push(node);
    this.map[id] = node;
  }

  addNode(id: string, node: CommentNode) {
    this.map[id] = node;
  }

  getNode(id: string | undefined): CommentNode | undefined {
    if (!id) {
      return undefined;
    }

    return this.map[id];
  }

  get nodeCount(): number {
    return Object.keys(this.map).length;
  }

  static fromObject(obj: CommentTree | null | undefined): CommentTree | undefined {
    if (!obj) {
      return undefined;
    }

    const tree = new CommentTree(obj.type, obj.rootNodes);

    const traverse = (node: CommentNode) => {
      tree.addNode(node.id, node);
      if (!isEmpty(node.children)) {
        node.children.forEach(traverse);
      }
    };

    flatMap(obj.rootNodes, (n) => n.children).forEach(traverse);

    return tree;
  }
}

export interface CommentNode {
  id: string;
  parentId?: string;
  authorId: string;
  authorName: string;
  url: string;
  body: string;
  bodyHtml: string | null;
  upvotes: number;
  downvotes: number;
  createdUtc: number;
  extracted?: boolean;
  children: CommentNode[];
}
