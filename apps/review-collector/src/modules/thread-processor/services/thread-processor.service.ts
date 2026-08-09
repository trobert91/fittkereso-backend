import { Injectable } from "@nestjs/common";
import { CommentTree, Thread } from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { ThreadExtractionService } from "@ebike-backend/thread-processor";

@Injectable()
export class ThreadProcessorService {
  private readonly logger = new CustomLogger(ThreadProcessorService.name);

  constructor(private readonly threadExtraction: ThreadExtractionService) {}

  public async process({
    threadId,
    tree,
  }: {
    threadId: string;
    tree: CommentTree | undefined;
    lockThread?: boolean;
  }): Promise<Thread | undefined> {
    if (!tree || !tree.rootNodes) {
      this.logger.warn(
        `No comment tree or root nodes found for thread ${threadId}.`,
        { threadId },
      );
      return;
    }

    const result = await this.threadExtraction.extract({ threadId, tree });

    this.logger.debug(`Thread extraction finished for thread ${threadId}.`, {
      threadId,
      status: result.status,
      durationMs: result.durationMs,
    });

    return undefined;
  }
}
