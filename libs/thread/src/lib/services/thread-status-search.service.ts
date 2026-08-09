import { Injectable } from "@nestjs/common";
import {
  ProductCategory,
  Thread,
  ThreadProductCategory,
  ThreadRepository,
  ThreadStatus,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class ThreadStatusSearchService {
  constructor(private readonly threadRepository: ThreadRepository) {}

  /**
   * Phase A: find threads waiting for LLM selection.
   *
   * Returns NEW threads where the ingestion-time relevance estimation cleared
   * `minRelevance`. Categories are NOT joined or filtered — they don't exist
   * yet for NEW threads (the LLM picks them in Phase A).
   *
   * REPROCESSING threads bypass Phase A entirely: they already have categories
   * from a prior run, so re-running the LLM would waste a call and risk
   * overwriting the existing assignment. They are drained directly in Phase B.
   *
   * Order: markedForSync first, then a relevance + recency blend.
   */
  public async findThreadsForSelection(
    limit: number,
    minRelevance: number,
  ): Promise<Thread[]> {
    return this.threadRepository.repo
      .createQueryBuilder("thread")
      .where(`thread.${nameOf<Thread>("status")} = :status`, {
        status: ThreadStatus.NEW,
      })
      .andWhere(
        `thread.${nameOf<Thread>("processRunning")} = :processRunning`,
        { processRunning: false },
      )
      .andWhere(
        `COALESCE(thread.${nameOf<Thread>("relevanceEstimation")}, 0) >= :minRelevance`,
        { minRelevance },
      )
      .orderBy(`thread.${nameOf<Thread>("markedForSync")}`, "DESC")
      .addOrderBy(
        `(COALESCE(thread.${nameOf<Thread>("relevanceEstimation")}, 0) * 0.7) + (GREATEST(0, 1.0 - EXTRACT(EPOCH FROM (NOW() - COALESCE(thread.${nameOf<Thread>("threadCreatedAt")}, thread.${nameOf<Thread>("createdAt")}))) / (90 * 86400)) * 100 * 0.3)`,
        "DESC",
      )
      .limit(limit)
      .getMany();
  }

  /**
   * Phase B: find threads ready for extraction.
   *
   * Returns SELECTED threads (just produced by Phase A) and REPROCESSING
   * threads (marked by deferred-resolution / comment-reprocess paths for a
   * fresh extraction run). Both already have categories assigned. Filtered
   * to threads that have at least one extraction-enabled category.
   *
   * Order: REPROCESSING first (they've been waiting longer in real time),
   * then markedForSync, then a relevance + recency blend on the LLM
   * relevance score.
   */
  public async findThreadsForExtraction(limit: number): Promise<Thread[]> {
    return this.threadRepository.repo
      .createQueryBuilder("thread")
      .leftJoinAndSelect(
        `thread.${nameOf<Thread>("categories")}`,
        "threadCategory",
      )
      .leftJoinAndSelect(
        `threadCategory.${nameOf<ThreadProductCategory>("productCategory")}`,
        "category",
      )
      .where(`thread.${nameOf<Thread>("status")} IN (:...statuses)`, {
        statuses: [ThreadStatus.SELECTED, ThreadStatus.REPROCESSING],
      })
      .andWhere(
        `threadCategory.${nameOf<ThreadProductCategory>("id")} IS NOT NULL`,
      )
      .andWhere(
        `category.${nameOf<ProductCategory>("extractionEnabled")} = :extractionEnabled`,
        { extractionEnabled: true },
      )
      .andWhere(
        `thread.${nameOf<Thread>("processRunning")} = :processRunning`,
        { processRunning: false },
      )
      .orderBy(
        `CASE WHEN thread.${nameOf<Thread>("status")} = :reprocessingStatus THEN 0 ELSE 1 END`,
        "ASC",
      )
      .setParameter("reprocessingStatus", ThreadStatus.REPROCESSING)
      .addOrderBy(`thread.${nameOf<Thread>("markedForSync")}`, "DESC")
      .addOrderBy(
        `(COALESCE(thread.${nameOf<Thread>("relevance")}, 0) * 0.7) + (GREATEST(0, 1.0 - EXTRACT(EPOCH FROM (NOW() - COALESCE(thread.${nameOf<Thread>("threadCreatedAt")}, thread.${nameOf<Thread>("createdAt")}))) / (90 * 86400)) * 100 * 0.3)`,
        "DESC",
      )
      .limit(limit)
      .getMany();
  }

  public async findThreadsToReprocess(
    limit: number,
    reprocessAfterDays: number,
  ): Promise<Thread[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - reprocessAfterDays);

    const lastProcessedAtColumn = `thread.${nameOf<Thread>("lastProcessedAt")}`;
    return this.threadRepository.repo
      .createQueryBuilder("thread")
      .leftJoinAndSelect(
        `thread.${nameOf<Thread>("categories")}`,
        "threadCategory",
      )
      .leftJoinAndSelect(
        `threadCategory.${nameOf<ThreadProductCategory>("productCategory")}`,
        "category",
      )
      .where(`thread.${nameOf<Thread>("status")} = :status`, {
        status: ThreadStatus.PROCESSED,
      })
      .andWhere(
        `threadCategory.${nameOf<ThreadProductCategory>("id")} IS NOT NULL`,
      )
      .andWhere(
        `category.${nameOf<ProductCategory>("extractionEnabled")} = :extractionEnabled`,
        {
          extractionEnabled: true,
        },
      )
      .andWhere(
        `thread.${nameOf<Thread>("processRunning")} = :processRunning`,
        { processRunning: false },
      )
      .andWhere(
        `(${lastProcessedAtColumn} IS NULL OR ${lastProcessedAtColumn} < :cutoff)`,
        { cutoff: cutoffDate },
      )
      .orderBy(`thread.${nameOf<Thread>("markedForSync")}`, "DESC")
      .addOrderBy(lastProcessedAtColumn, "ASC", "NULLS FIRST")
      .limit(limit)
      .getMany();
  }
}
