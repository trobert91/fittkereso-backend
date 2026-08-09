import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CommentStatus,
  ProductReference,
  ProductReferenceRepository,
  Thread,
  ThreadRepository,
  ThreadStatus,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { DebugTraceService } from "@ebike-backend/debug";
import { CustomLogger } from "@ebike-backend/logger";
import { nameOf } from "@ebike-backend/utils";
import { compact } from "lodash";

@Injectable()
export class CommentReprocessService {
  private readonly logger = new CustomLogger(CommentReprocessService.name);

  constructor(
    private readonly commentRepository: UserCommentRepository,
    private readonly productReferenceRepository: ProductReferenceRepository,
    private readonly threadRepository: ThreadRepository,
    private readonly debugTrace: DebugTraceService,
  ) {}

  async retryComment(commentId: string, reviewer: string): Promise<void> {
    const comment = await this.commentRepository.repo.findOne({
      where: { id: commentId },
      relations: [
        nameOf<UserComment>("thread"),
        nameOf<UserComment>("productReferences"),
      ],
    });

    if (!comment) {
      throw new NotFoundException(`Comment ${commentId} not found`);
    }

    const thread = comment.thread;

    if (thread.processRunning || thread.status === ThreadStatus.PROCESSING) {
      throw new ConflictException(
        `Thread ${thread.id} is currently being processed`,
      );
    }

    const statusBefore = comment.status;
    const deletedRefIds = compact(
      (comment.productReferences ?? []).map((r) => r.id),
    );

    await this.commentRepository.repo.manager.connection.transaction(
      async (manager) => {
        if (deletedRefIds.length > 0) {
          await manager.delete(ProductReference, deletedRefIds);
        }

        comment.status = CommentStatus.NEW;
        comment.lastProcessedStatus = null;
        comment.moderations = null;
        comment.context = null;
        comment.relevance = undefined;
        comment.moderationPriority = undefined;
        comment.issueSeverity = undefined;
        comment.openIssueSeverity = undefined;
        comment.validated = false;
        comment.validationDecision = undefined;
        comment.checkedByUserId = undefined;
        await manager.save(UserComment, comment);

        const result = await manager
          .createQueryBuilder()
          .update(Thread)
          .set({ status: ThreadStatus.REPROCESSING })
          .where(
            `id = :threadId AND ${nameOf<Thread>("status")} != :processing AND ${nameOf<Thread>("processRunning")} = false`,
            {
              threadId: thread.id,
              processing: ThreadStatus.PROCESSING,
            },
          )
          .execute();

        if (result.affected === 0) {
          throw new ConflictException(
            `Thread ${thread.id} is currently being processed`,
          );
        }
      },
    );

    this.logger.log(
      `Comment ${commentId} reset for retry by ${reviewer}: ${statusBefore} → new`,
      { commentId, threadId: thread.id, reviewer },
    );

    await this.recordRetryTrace(
      comment,
      thread.id,
      statusBefore,
      deletedRefIds,
      reviewer,
    );
  }

  private async recordRetryTrace(
    comment: UserComment,
    threadId: string,
    statusBefore: CommentStatus,
    deletedRefIds: string[],
    reviewer: string,
  ): Promise<void> {
    try {
      await this.debugTrace.record({
        threadId,
        commentId: comment.id,
        step: "admin_retry",
        statusBefore,
        statusAfter: CommentStatus.NEW,
        durationMs: 0,
        data: {
          summary: `Comment reset for retry by admin: ${statusBefore} → new (${deletedRefIds.length} ref(s) deleted)`,
          reset: {
            reason: "admin_retry",
            reviewer,
            deletedRefCount: deletedRefIds.length,
          },
        },
      });
    } catch (error: unknown) {
      this.logger.warn("Failed to record admin-retry trace", {
        error,
        commentId: comment.id,
      });
    }
  }
}
