import { Comment as SnoowrapComment, Submission } from "snoowrap";
import { isEmpty } from "lodash";
import { CommentTree, CommentNode } from "@ebike-backend/database";
import { isUserComment } from "@ebike-backend/reddit";
import { sanitizeText } from "@ebike-backend/utils";

export class RedditThreadTreeExtractor {
  private commentMap: Record<string, SnoowrapComment[]> = {};

  constructor(private readonly submission: Submission) {}

  public createCommentTree(): CommentTree {
    this.commentMap = this.createCommentMap(this.submission);

    // Root = submission (OP)
    const rootNode = this.createNodeFromSubmission();
    const tree = new CommentTree("reddit", [rootNode]);

    this.processNode(tree, rootNode);

    return tree;
  }

  private createNodeFromSubmission(): CommentNode {
    return {
      id: "OP",
      authorId: this.submission.author_fullname,
      authorName: this.submission.author.name,
      url: this.submission.permalink,
      body: sanitizeText(this.submission.selftext),
      bodyHtml: this.submission.selftext_html,
      upvotes: this.submission.ups,
      downvotes: this.submission.downs,
      createdUtc: this.submission.created_utc,
      extracted: false,
      children: [],
    };
  }

  private createNodeFromComment(
    comment: SnoowrapComment,
    parentId?: string,
  ): CommentNode {
    return {
      id: comment.id,
      parentId,
      authorId: comment.author_fullname,
      authorName: comment.author.name,
      url: comment.permalink,
      body: sanitizeText(comment.body),
      bodyHtml: comment.body_html,
      upvotes: comment.ups,
      downvotes: comment.downs,
      createdUtc: comment.created_utc,
      extracted: false,
      children: [],
    };
  }

  private processNode(tree: CommentTree, node: CommentNode) {
    const children = this.commentMap[node.id] ?? [];

    for (const child of children) {
      // Skip automoderator / bot comments and their entire subtree. Bot
      // posts carry no user content, and their replies are almost always
      // either bot-flagging-bot noise or moderation chatter — none of it
      // useful for downstream extraction.
      if (
        !isUserComment({
          body: child.body,
          authorName: child.author?.name,
        })
      ) {
        continue;
      }

      const childNode = this.createNodeFromComment(child, node.id);
      node.children.push(childNode);
      tree.addNode(childNode.id, childNode);

      this.processNode(tree, childNode);
    }
  }

  private createCommentMap(
    submission: Submission,
  ): Record<string, SnoowrapComment[]> {
    const map: Record<string, SnoowrapComment[]> = {
      OP: submission.comments ?? [],
    };

    for (const comment of submission.comments) {
      this.addCommentToMap(comment, map);
    }

    return map;
  }

  private addCommentToMap(
    comment: SnoowrapComment,
    map: Record<string, SnoowrapComment[]>,
  ): Record<string, SnoowrapComment[]> {
    map[comment.id] = comment.replies ?? [];

    if (!isEmpty(comment.replies)) {
      for (const reply of comment.replies) {
        this.addCommentToMap(reply, map);
      }
    }

    return map;
  }
}
