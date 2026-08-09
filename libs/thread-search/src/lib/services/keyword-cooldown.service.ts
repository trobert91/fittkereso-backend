import { Injectable } from "@nestjs/common";
import {
  ThreadSearchKeywordRepository,
  ThreadPlatform,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";

export interface CooldownEntry {
  keyword: string;
  weeksSinceLastSearch: number;
}

const MILLISECONDS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Keyword-level cooldown wrapper over `ThreadSearchKeyword`.
 *
 * Two responsibilities:
 *  1. Return which keywords are still within the cooldown window for a
 *     category so the orchestrator can filter them out of the planner's
 *     output.
 *  2. Upsert `lastSearchedAt = now()` for each keyword the executor fired.
 *
 * Subreddit scope is intentionally not tracked here — the planner generates
 * keywords without subreddit affinity, so cooldown is keyword-level.
 */
@Injectable()
export class KeywordCooldownService {
  private readonly logger = new CustomLogger(KeywordCooldownService.name);

  constructor(
    private readonly threadSearchKeywordRepository: ThreadSearchKeywordRepository,
  ) {}

  /**
   * All keywords searched within `cooldownDays` for this category, keyed by
   * lowercased keyword for O(1) lookup during filtering.
   */
  async getActiveCooldown(
    categoryId: string,
    cooldownDays: number,
  ): Promise<Map<string, CooldownEntry>> {
    const cutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
    const now = Date.now();

    const records = await this.threadSearchKeywordRepository.repo
      .createQueryBuilder("k")
      .where('k."categoryId" = :categoryId', { categoryId })
      .andWhere('k."lastSearchedAt" > :cutoff', { cutoff })
      .getMany();

    const map = new Map<string, CooldownEntry>();
    for (const record of records) {
      const weeksSinceLastSearch =
        (now - record.lastSearchedAt.getTime()) / MILLISECONDS_PER_WEEK;
      map.set(record.keyword.toLowerCase(), {
        keyword: record.keyword,
        weeksSinceLastSearch,
      });
    }

    this.logger.debug("Cooldown set loaded", {
      categoryId,
      cooldownDays,
      keywordCount: map.size,
    });

    return map;
  }

  /**
   * Atomic upsert via `ON CONFLICT`. If the row exists, `lastSearchedAt`
   * advances to now; otherwise a fresh row is inserted.
   */
  async markSearched(params: {
    categoryId: string;
    categorySlug: string;
    keyword: string;
    platform: ThreadPlatform;
  }): Promise<void> {
    const { categoryId, categorySlug, keyword, platform } = params;

    await this.threadSearchKeywordRepository.repo.upsert(
      { keyword, platform, categoryId, lastSearchedAt: new Date() },
      {
        conflictPaths: ["keyword", "platform", "categoryId"],
        skipUpdateIfNoValuesChanged: false,
      },
    );

    this.logger.debug("Marked searched", {
      categoryId,
      categorySlug,
      keyword,
      platform,
    });
  }
}
