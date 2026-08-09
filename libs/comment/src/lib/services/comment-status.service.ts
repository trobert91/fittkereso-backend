import { Injectable } from "@nestjs/common";
import {
  CommentModeration,
  CommentStatus,
  ThreadRepository,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class CommentStatusService {
  constructor(
    private readonly repo: UserCommentRepository,
    private readonly threadRepo: ThreadRepository,
  ) {}

  public async updateStatusWithId(
    id: string,
    targetStatus: CommentStatus,
    reviewer: string,
  ): Promise<UserComment> {
    const comment = await this.repo.findOneOrFail({
      where: { id },
      relations: [nameOf<UserComment>("thread")],
    });

    return this.updateStatus(comment, targetStatus, reviewer);
  }

  public async updateStatus(
    comment: UserComment,
    targetStatus: CommentStatus,
    reviewer: string,
    checkStatusTransition = true,
  ): Promise<UserComment> {
    if (comment.status === targetStatus) {
      return comment;
    }

    if (checkStatusTransition) {
      this.checkStatusTransition(comment.status, targetStatus);
    }

    comment.status = targetStatus;
    const moderation: CommentModeration = {
      reviewedBy: reviewer,
      suggestedStatus: targetStatus,
      source: "admin",
      createdAt: new Date().toISOString(),
    };
    comment.moderations = [...(comment.moderations ?? []), moderation];

    const saved = await this.repo.save(comment);

    if (comment.status === CommentStatus.APPROVED) {
      comment.thread.markedForSync = true;
      await this.threadRepo.save(comment.thread);
    }

    return saved;
  }

  public async toggleChecked(
    commentId: string,
    userId: string,
  ): Promise<UserComment> {
    const comment = await this.repo.findByIdOrFail(commentId);

    const checked = comment.checkedByUserId ?? [];
    const index = checked.indexOf(userId);

    if (index === -1) {
      comment.checkedByUserId = [...checked, userId];
    } else {
      comment.checkedByUserId = checked.filter(
        (existingId) => existingId !== userId,
      );
    }

    return this.repo.save(comment);
  }

  private checkStatusTransition(
    currentStatus: CommentStatus,
    targetStatus: CommentStatus,
  ): void {
    const enabledTargetStatuses = [
      CommentStatus.APPROVED,
      CommentStatus.IN_REVIEW,
      CommentStatus.DELETED,
    ];
    const enabledCurrentStatuses = [
      CommentStatus.APPROVED,
      CommentStatus.IN_REVIEW,
      CommentStatus.DELETED,
    ];

    if (!enabledCurrentStatuses.includes(currentStatus)) {
      throw new Error(
        `Cannot manually change comment from status: ${currentStatus}`,
      );
    }

    if (!enabledTargetStatuses.includes(targetStatus)) {
      throw new Error(`Cannot manually set comment to status: ${targetStatus}`);
    }
  }
}
