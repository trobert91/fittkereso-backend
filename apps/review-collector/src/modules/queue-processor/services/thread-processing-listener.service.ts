import { Injectable } from "@nestjs/common";
import {
  Thread,
  ThreadRepository,
  ThreadStatus,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { ThreadMessage } from "@ebike-backend/task";
import { ProcessorConfigService } from "@ebike-backend/config";
import { MediaAnalyzerService } from "@ebike-backend/thread-processor";
import { ThreadProcessorService } from "../../thread-processor/services/thread-processor.service";
import { ThreadTreeService } from "@ebike-backend/thread";
import { isEmpty } from "lodash";

@Injectable()
export class ThreadProcessingListener {
  private readonly logger = new CustomLogger(ThreadProcessingListener.name);

  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly threadTreeService: ThreadTreeService,
    private readonly threadProcessor: ThreadProcessorService,
    private readonly mediaAnalyzer: MediaAnalyzerService,
    private readonly processorConfig: ProcessorConfigService,
  ) {}

  async process(message: ThreadMessage): Promise<any> {
    this.logger.debug(
      `Processing ThreadProcessing job for thread ${message.threadId}.`,
      {
        threadId: message.threadId,
      },
    );

    const entity = await this.threadRepository.findByIdOrFail(message.threadId);

    try {
      entity.processRunning = true;
      await this.threadRepository.save(entity);

      this.logger.debug(
        `Processing ThreadProcessing job for title "${entity.title}".`,
        {
          threadId: entity.id,
        },
      );

      const tree = await this.threadTreeService.getOrCreateTree(entity);

      // Analyze thread media before extraction (content is persisted to thread)
      await this.analyzeThreadMedia(entity);

      await this.threadProcessor.process({
        threadId: entity.id,
        tree,
        lockThread: false,
      });

      // Reload to pick up fields the inner pipeline wrote (e.g. opSummary) so
      // the post-extraction save doesn't clobber them with stale in-memory state.
      const entityToSave = await this.threadRepository.findByIdOrFail(
        entity.id,
      );
      entityToSave.commentTree = tree;
      entityToSave.lastSynced = new Date();
      entityToSave.lastProcessedAt = new Date();
      entityToSave.status = ThreadStatus.PROCESSED;

      await this.threadRepository.save(entityToSave);

      this.logger.debug(
        `Finished processing RedditThreadExtraction job for thread "${entityToSave.title}".`,
      );
    } catch (error: unknown) {
      this.logger.error("Error processing RedditThreadExtraction job.", error);
      throw error;
    } finally {
      await this.threadRepository.repo.update(entity.id, {
        processRunning: false,
      });
    }
  }

  private async analyzeThreadMedia(thread: Thread): Promise<void> {
    const hasUnanalyzedMedia = thread.media?.some(
      (mediaItem) => !isEmpty(mediaItem.url) && !mediaItem.content,
    );
    if (!hasUnanalyzedMedia) return;

    try {
      const model = this.processorConfig.imageAnalysis.model;
      thread.media = await this.mediaAnalyzer.analyze({
        media: thread.media!,
        model,
        threadId: thread.id,
      });
      await this.threadRepository.repo.update(thread.id, {
        media: thread.media,
      });
    } catch (error) {
      this.logger.warn("Thread media analysis failed, continuing without it", {
        error,
        threadId: thread.id,
      });
    }
  }
}
