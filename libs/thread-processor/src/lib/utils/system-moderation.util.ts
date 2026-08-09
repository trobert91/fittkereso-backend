import {
  CommentModeration,
  CommentStatus,
  UserComment,
} from "@ebike-backend/database";

/**
 * Append a pipeline-authored (`source: 'system'`) moderation entry to a comment
 * — the audit trail for an automatic SKIPPED/DELETED decision. Shared by the
 * identification pass and the subtree processor so the recorded reason + source
 * stay consistent (admin UI + run-details tallies read these).
 */
export function appendSystemModeration(
  comment: UserComment,
  reviewComment: string,
  suggestedStatus?: CommentStatus,
): void {
  const moderation: CommentModeration = {
    reviewedBy: "pipeline",
    source: "system",
    reviewComment,
    createdAt: new Date().toISOString(),
    ...(suggestedStatus && { suggestedStatus }),
  };
  comment.moderations = [...(comment.moderations ?? []), moderation];
}
