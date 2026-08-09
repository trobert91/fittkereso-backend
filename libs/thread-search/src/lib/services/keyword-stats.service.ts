import { Injectable } from "@nestjs/common";
import { Thread, ThreadRepository } from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { nameOf } from "@ebike-backend/utils";

export interface KeywordStat {
  keyword: string;
  /** Total thread count linked to this keyword (sum of all status buckets). */
  discovered: number;
  /** Threads that reached ThreadStatus.PROCESSED (value 'extracted') — the "useful yield". */
  processed: number;
  /** Threads tombstoned anywhere along the way (LOW_ESTIMATION + LLM_NO_CATEGORY + LLM_LOW_RELEVANCE). */
  rejected: number;
}

interface RawStatRow {
  keyword: string;
  discovered: string;
  processed: string;
  rejected: string;
}

/**
 * Pure aggregation over `thread.keywords` joined to the category. No
 * persisted counters — stats are computed fresh per call.
 *
 * "In-flight" threads (NEW, SELECTED, PROCESSING) are intentionally excluded
 * — they're neither yield nor rejection yet. The planner sees the keyword
 * histogram split into completed-useful vs definitively-rejected.
 */
@Injectable()
export class KeywordStatsService {
  private readonly logger = new CustomLogger(KeywordStatsService.name);

  constructor(private readonly threadRepository: ThreadRepository) {}

  async getStats(
    categoryId: string,
    yieldHistoryWeeks: number,
  ): Promise<KeywordStat[]> {
    // `thread_id` / `category_id` are explicit @JoinColumn renames on
    // ThreadProductCategory; nameOf only knows the property names, not the
    // mapped snake_case columns, so those stay hardcoded here.
    // `"createdAt"` needs quoting — unquoted identifiers are lowercased.
    const rows = await this.threadRepository.repo.query<RawStatRow[]>(
      `
      SELECT k AS keyword,
             COUNT(*) AS discovered,
             COUNT(*) FILTER (WHERE t.${nameOf<Thread>("status")} = 'extracted') AS processed,
             COUNT(*) FILTER (WHERE t.${nameOf<Thread>("status")} IN ('low_estimation','llm_no_category','llm_low_relevance')) AS rejected
      FROM thread t
      INNER JOIN thread_product_category tpc ON tpc.thread_id = t.${nameOf<Thread>("id")}
      CROSS JOIN LATERAL UNNEST(t.${nameOf<Thread>("keywords")}) AS k
      WHERE tpc.category_id = $1
        AND t."${nameOf<Thread>("createdAt")}" > now() - ($2 || ' weeks')::interval
      GROUP BY k
      `,
      [categoryId, yieldHistoryWeeks.toString()],
    );

    const stats = rows.map((row) => ({
      keyword: row.keyword,
      discovered: Number(row.discovered),
      processed: Number(row.processed),
      rejected: Number(row.rejected),
    }));

    this.logger.debug("Stats fetched", {
      categoryId,
      yieldHistoryWeeks,
      keywordCount: stats.length,
    });

    return stats;
  }
}
