import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { nameOf } from "@ebike-backend/utils";
import { BasePostgresRepository } from "./base-postgres-repository";
import {
  TranslationCache,
  TranslationCacheSource,
} from "../models/translation-cache.entity";

export interface BatchCacheLookupParams {
  sourceLanguage: string;
  targetLanguage: string;
  sourceTexts: string[]; // already normalized (lowercase + trim)
}

export interface CacheStoreItem {
  sourceText: string; // normalized
  translatedText: string;
  model?: string;
  costInDollars?: number;
}

export interface BatchCacheStoreParams {
  sourceLanguage: string;
  targetLanguage: string;
  source: TranslationCacheSource;
  items: CacheStoreItem[];
  ttlDays?: number;
}

@Injectable()
export class TranslationCacheRepository extends BasePostgresRepository<TranslationCache> {
  constructor(
    @InjectRepository(TranslationCache, "postgres")
    repository: Repository<TranslationCache>,
  ) {
    super(repository, TranslationCache);
  }

  /**
   * Look up many source texts at once. Returns a Map keyed by normalized sourceText.
   * Missing keys mean cache miss.
   */
  async findBatchCacheHits(
    params: BatchCacheLookupParams,
  ): Promise<Map<string, string>> {
    if (params.sourceTexts.length === 0) return new Map();

    const now = new Date();
    const expiresAtColumn = `tc.${nameOf<TranslationCache>("expiresAt")}`;
    const rows = await this.repo
      .createQueryBuilder("tc")
      .where(
        `tc.${nameOf<TranslationCache>("sourceLanguage")} = :sourceLanguage`,
        {
          sourceLanguage: params.sourceLanguage,
        },
      )
      .andWhere(
        `tc.${nameOf<TranslationCache>("targetLanguage")} = :targetLanguage`,
        {
          targetLanguage: params.targetLanguage,
        },
      )
      .andWhere(
        `tc.${nameOf<TranslationCache>("sourceText")} IN (:...sourceTexts)`,
        {
          sourceTexts: params.sourceTexts,
        },
      )
      .andWhere(`(${expiresAtColumn} IS NULL OR ${expiresAtColumn} > :now)`, {
        now,
      })
      .getMany();

    if (rows.length > 0) {
      // Fire-and-forget bulk hit counter update — don't block the lookup
      void this.repo
        .createQueryBuilder()
        .update(TranslationCache)
        .set({
          hitCount: () => '"hitCount" + 1',
          lastAccessedAt: now,
        })
        .where({ id: In(rows.map((row) => row.id)) })
        .execute();
    }

    return new Map(rows.map((row) => [row.sourceText, row.translatedText]));
  }

  /**
   * Store many translations at once. Uses upsert on the composite unique index so
   * concurrent writes for the same key don't fail.
   */
  async storeBatch(params: BatchCacheStoreParams): Promise<void> {
    if (params.items.length === 0) return;

    const now = new Date();
    const expiresAt = params.ttlDays
      ? new Date(now.getTime() + params.ttlDays * 24 * 60 * 60 * 1000)
      : null;

    const rows = params.items.map((item) => ({
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
      sourceText: item.sourceText,
      translatedText: item.translatedText,
      source: params.source,
      model: item.model,
      costInDollars: item.costInDollars ?? 0,
      hitCount: 0,
      lastAccessedAt: now,
      expiresAt: expiresAt ?? undefined,
    }));

    await this.repo.upsert(rows, {
      conflictPaths: ["sourceLanguage", "targetLanguage", "sourceText"],
      skipUpdateIfNoValuesChanged: true,
    });
  }
}
