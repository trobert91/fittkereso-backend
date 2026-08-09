import { Injectable } from "@nestjs/common";
import {
  CommentTree,
  Thread,
  ThreadRun,
  ThreadRunRepository,
  ThreadRunStatus,
} from "@ebike-backend/database";
import { DebugTraceService } from "@ebike-backend/debug";
import { CustomLogger } from "@ebike-backend/logger";
import { SubtreeProcessorService } from "./subtree-processor.service";
import { ThreadRunDetailsBuilderService } from "./thread-run-details-builder.service";

export type ThreadExtractionStatus = "completed" | "skipped" | "failed";

export interface ThreadExtractionInput {
  threadId: string;
  tree: CommentTree;
}

export interface ThreadExtractionResult {
  threadId: string;
  status: ThreadExtractionStatus;
  durationMs: number;
}

@Injectable()
export class ThreadExtractionService {
  private readonly logger = new CustomLogger(ThreadExtractionService.name);

  constructor(
    private readonly orchestrator: SubtreeProcessorService,
    private readonly threadRunRepository: ThreadRunRepository,
    private readonly debugTrace: DebugTraceService,
    private readonly detailsBuilder: ThreadRunDetailsBuilderService,
  ) {}

  async extract(input: ThreadExtractionInput): Promise<ThreadExtractionResult> {
    const startedAt = new Date();
    const start = Date.now();
    const run = await this.createRun(input.threadId, startedAt);

    try {
      const processResult = await this.orchestrator.process(
        input.threadId,
        input.tree,
      );
      const stats = this.debugTrace.flushThreadRunStats(input.threadId);
      const durationMs = Date.now() - start;
      const details = await this.detailsBuilder.build({
        threadId: input.threadId,
        processResult,
        stats,
      });

      await this.threadRunRepository.repo.update(run.id, {
        status: ThreadRunStatus.COMPLETED,
        completedAt: new Date(),
        durationMs,
        totalCostUsd: stats.totalCost,
        details,
      });

      return {
        threadId: input.threadId,
        status: "completed",
        durationMs,
      };
    } catch (error) {
      const stats = this.debugTrace.flushThreadRunStats(input.threadId);
      const durationMs = Date.now() - start;
      const err = error as Error | undefined;
      const details = await this.buildFailureDetails(input.threadId, stats);

      await this.threadRunRepository.repo.update(run.id, {
        status: ThreadRunStatus.FAILED,
        completedAt: new Date(),
        durationMs,
        totalCostUsd: stats.totalCost,
        details,
        error: err
          ? { message: err.message, name: err.name }
          : { message: String(error) },
      });

      this.logger.error(
        `Thread extraction failed for thread ${input.threadId}.`,
        error,
        { threadId: input.threadId },
      );
      throw error;
    }
  }

  private async createRun(
    threadId: string,
    startedAt: Date,
  ): Promise<ThreadRun> {
    return this.threadRunRepository.repo.save(
      this.threadRunRepository.repo.create({
        thread: { id: threadId } as Thread,
        status: ThreadRunStatus.RUNNING,
        startedAt,
      }),
    );
  }

  private async buildFailureDetails(
    threadId: string,
    stats: ReturnType<DebugTraceService["flushThreadRunStats"]>,
  ) {
    try {
      return await this.detailsBuilder.build({ threadId, stats });
    } catch (buildError) {
      this.logger.warn(
        `Failed to build ThreadRun details on failure path for thread ${threadId}.`,
        { threadId, error: buildError },
      );
      return null;
    }
  }
}
