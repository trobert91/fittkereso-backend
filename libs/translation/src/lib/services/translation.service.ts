import { Injectable } from '@nestjs/common';
import {
  CacheStoreItem,
  TranslationCacheRepository,
} from '@fittkereso-backend/database';
import {
  DynamicConfigService,
  TranslationConfig,
} from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { TranslationMetricsService } from '@fittkereso-backend/metrics';
import { AiChatService } from '@fittkereso-backend/ai';
import { compact, uniq } from 'lodash';

export interface TranslateBatchParams {
  /** Raw source strings. May contain duplicates, empties, or undefined — all deduped/filtered internally. */
  texts: Array<string | undefined>;
  sourceLanguage?: string;
  targetLanguage?: string;
  /**
   * Free-form context string describing the domain of the strings being translated.
   * Injected into the LLM system prompt to disambiguate terms whose translation
   * depends on the surrounding domain. Ignored when everything resolves from the
   * dictionary + cache (no LLM call is made).
   *
   * Example (from Arukereso scraper):
   *   "Technical specification values from an arukereso.hu product listing in the
   *   \"Mice\" category. Preserve units, model numbers, and technical jargon."
   *
   * Callers SHOULD pass a specific context whenever possible — "optikai" means
   * "optical sensor" for mice but "optical input" for soundbars, and the LLM
   * needs the hint to pick the right variant.
   */
  context?: string;
}

export interface BatchTranslationStats {
  /** Total raw strings passed in (including duplicates, empties, undefined). */
  inputCount: number;
  /** Unique normalized strings after dedupe — this is the number actually processed. */
  uniqueCount: number;
  fromDictionary: number;
  fromCache: number;
  fromLlm: number;
  /** Unique strings that fell through to identity (LLM disabled or failed). */
  untranslated: number;
}

export interface TranslateBatchResult {
  /**
   * Map from normalized (lowercased + trimmed) source text → translated text.
   * Only contains entries that were successfully translated.
   */
  translations: Map<string, string>;
  stats: BatchTranslationStats;
  /**
   * Sync helper: normalize a raw input string and look it up.
   * Returns the translation if found, or the trimmed raw input as a safe fallback.
   */
  lookup: (raw: string | undefined) => string | undefined;
}

// Strings that are purely numeric (integers, decimals, optional leading sign) need
// no translation — they carry no language. Also matches common grouping characters
// like commas and spaces (e.g. "1,234", "12 000").
const NUMERIC_ONLY_PATTERN = /^[-+]?[\d\s.,]+$/;

const isNumericOnly = (value: string): boolean =>
  NUMERIC_ONLY_PATTERN.test(value) && /\d/.test(value);

const BATCH_TRANSLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['translations'],
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'translation'],
        properties: {
          source: { type: 'string' },
          translation: { type: 'string' },
        },
      },
    },
  },
};

@Injectable()
export class TranslationService {
  private readonly logger = new CustomLogger(TranslationService.name);

  constructor(
    private readonly dynamicConfig: DynamicConfigService,
    private readonly cacheRepo: TranslationCacheRepository,
    private readonly aiChat: AiChatService,
    private readonly metrics: TranslationMetricsService,
  ) {}

  /**
   * Translate a batch of strings.
   *
   * Flow per batch:
   *   1. NORMALIZE + DEDUPE: lowercase+trim, drop empties/undefined, uniq() — every
   *      unique string is processed exactly once regardless of input duplication
   *   2. Dictionary lookup for each unique normalized value (in-memory, O(1) per key)
   *   3. DB cache lookup for the remaining unknowns (single batch query)
   *   4. If anything is still unknown, ONE batched LLM call (chunked if > maxBatchSize)
   *   5. Store LLM results in the cache
   *   6. Return a Map<normalized, translated> plus a `lookup(raw)` helper that
   *      re-normalizes on the way in so callers never see dedup concerns
   *
   * If dictionary + cache cover everything, steps 4 and 5 are skipped entirely.
   * Callers can pass duplicated, mixed-case, or padded input safely.
   */
  async translateBatch(
    params: TranslateBatchParams,
  ): Promise<TranslateBatchResult> {
    const startedAt = Date.now();
    const config = this.getConfig();
    const sourceLanguage =
      params.sourceLanguage ?? config.defaultSourceLanguage ?? 'hu';
    const targetLanguage =
      params.targetLanguage ?? config.defaultTargetLanguage ?? 'en';

    // 1. NORMALIZE + DEDUPE — run ONCE up front, before any lookups.
    //    - compact() drops undefined/null/empty strings
    //    - lowercase + trim normalizes each entry into a canonical lookup key
    //    - filter out purely numeric strings — they carry no language and don't
    //      need translating. The lookup() helper returns them unchanged on the
    //      way out so callers still get their raw value back.
    //    - uniq() collapses duplicates (e.g. 5 "Van" values → 1 lookup)
    const uniqueNormalized = uniq(
      compact(params.texts.map((text) => text?.toLowerCase().trim())),
    ).filter((text) => !isNumericOnly(text));

    const translations = new Map<string, string>();
    const stats: BatchTranslationStats = {
      inputCount: params.texts.length,
      uniqueCount: uniqueNormalized.length,
      fromDictionary: 0,
      fromCache: 0,
      fromLlm: 0,
      untranslated: 0,
    };

    const lookup = (raw: string | undefined): string | undefined => {
      if (!raw) return raw;
      const trimmed = raw.trim();
      if (sourceLanguage === targetLanguage) return trimmed;
      if (isNumericOnly(trimmed)) return trimmed;
      const normalized = trimmed.toLowerCase();
      return translations.get(normalized) ?? trimmed;
    };

    // Short-circuit: empty input
    if (uniqueNormalized.length === 0) {
      this.metrics.recordBatch({
        sourceLanguage,
        targetLanguage,
        outcome: 'empty',
        durationSeconds: (Date.now() - startedAt) / 1000,
      });
      return { translations, stats, lookup };
    }

    // Short-circuit: same-language → identity (no lookups at all)
    if (sourceLanguage === targetLanguage) {
      this.metrics.recordBatch({
        sourceLanguage,
        targetLanguage,
        outcome: 'identity',
        durationSeconds: (Date.now() - startedAt) / 1000,
      });
      return { translations, stats, lookup };
    }

    // 2. Dictionary pass
    const dict = config.dictionary?.[sourceLanguage] ?? {};
    const cacheLookupQueue: string[] = [];
    for (const normalized of uniqueNormalized) {
      const hit = dict[normalized];
      if (hit !== undefined) {
        translations.set(normalized, hit);
        stats.fromDictionary++;
      } else {
        cacheLookupQueue.push(normalized);
      }
    }

    // 3. DB cache pass (single batch query)
    if (cacheLookupQueue.length > 0) {
      const cacheHits = await this.cacheRepo.findBatchCacheHits({
        sourceLanguage,
        targetLanguage,
        sourceTexts: cacheLookupQueue,
      });

      const llmQueue: string[] = [];
      for (const normalized of cacheLookupQueue) {
        const hit = cacheHits.get(normalized);
        if (hit !== undefined) {
          translations.set(normalized, hit);
          stats.fromCache++;
        } else {
          llmQueue.push(normalized);
        }
      }

      // 4. LLM pass (only if anything is still unknown)
      if (llmQueue.length > 0) {
        if (config.enabled === false) {
          stats.untranslated = llmQueue.length;
        } else {
          await this.runLlmPass({
            llmQueue,
            sourceLanguage,
            targetLanguage,
            context: params.context,
            translations,
            stats,
            config,
          });
        }
      }
    }

    this.metrics.recordBatch({
      sourceLanguage,
      targetLanguage,
      outcome: 'success',
      durationSeconds: (Date.now() - startedAt) / 1000,
    });
    this.metrics.recordItems({
      sourceLanguage,
      targetLanguage,
      fromDictionary: stats.fromDictionary,
      fromCache: stats.fromCache,
      fromLlm: stats.fromLlm,
      untranslated: stats.untranslated,
    });

    const translatedCount =
      stats.fromDictionary + stats.fromCache + stats.fromLlm;
    this.logger.debug(
      `translateBatch completed: ${translatedCount}/${stats.uniqueCount} translated ` +
        `(dictionary=${stats.fromDictionary}, cache=${stats.fromCache}, llm=${stats.fromLlm}, untranslated=${stats.untranslated})`,
      {
        sourceLanguage,
        targetLanguage,
        translatedCount,
        ...stats,
      },
    );

    return { translations, stats, lookup };
  }

  private async runLlmPass(params: {
    llmQueue: string[];
    sourceLanguage: string;
    targetLanguage: string;
    context?: string;
    translations: Map<string, string>;
    stats: BatchTranslationStats;
    config: TranslationConfig;
  }): Promise<void> {
    const {
      llmQueue,
      sourceLanguage,
      targetLanguage,
      context,
      translations,
      stats,
      config,
    } = params;

    try {
      const llmResults = await this.callLlmBatched({
        texts: llmQueue,
        sourceLanguage,
        targetLanguage,
        context,
        maxBatchSize: config.maxBatchSize ?? 50,
        model: config.model ?? 'deepseek-v4-flash',
      });

      const toStore: CacheStoreItem[] = [];
      for (const [normalized, translated] of llmResults.entries()) {
        translations.set(normalized, translated);
        stats.fromLlm++;
        toStore.push({
          sourceText: normalized,
          translatedText: translated,
          model: config.model,
        });
      }

      stats.untranslated = llmQueue.length - llmResults.size;

      // 5. Store LLM results in cache
      if (toStore.length > 0) {
        await this.cacheRepo.storeBatch({
          sourceLanguage,
          targetLanguage,
          source: 'llm',
          items: toStore,
          ttlDays: config.cacheTtlDays,
        });
      }
    } catch (error: unknown) {
      this.logger.warn('Batch translation LLM call failed', {
        sourceLanguage,
        targetLanguage,
        pendingCount: llmQueue.length,
        error: error instanceof Error ? error.message : String(error),
      });
      stats.untranslated = llmQueue.length;
    }
  }

  private getConfig(): TranslationConfig {
    return this.dynamicConfig.translation ?? {};
  }

  /**
   * Chunk the LLM queue into batches of `maxBatchSize` and call the LLM for each chunk.
   * Returns a flat Map covering all successfully translated strings.
   */
  private async callLlmBatched(params: {
    texts: string[];
    sourceLanguage: string;
    targetLanguage: string;
    context?: string;
    maxBatchSize: number;
    model: string;
  }): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    for (
      let start = 0;
      start < params.texts.length;
      start += params.maxBatchSize
    ) {
      const chunk = params.texts.slice(start, start + params.maxBatchSize);
      const chunkResults = await this.callLlmOnce({
        texts: chunk,
        sourceLanguage: params.sourceLanguage,
        targetLanguage: params.targetLanguage,
        context: params.context,
        model: params.model,
      });
      for (const [key, value] of chunkResults.entries()) {
        result.set(key, value);
      }
    }

    return result;
  }

  private async callLlmOnce(params: {
    texts: string[];
    sourceLanguage: string;
    targetLanguage: string;
    context?: string;
    model: string;
  }): Promise<Map<string, string>> {
    const contextBlock = params.context
      ? `Domain context: ${params.context}\n\n`
      : '';

    const systemPrompt =
      `You are a technical translator. Translate each item from ${params.sourceLanguage} to ${params.targetLanguage}.\n\n` +
      contextBlock +
      `Rules:\n` +
      `- Preserve technical terms, units, model numbers, and brand names exactly.\n` +
      `- Use the domain context above to disambiguate terms whose meaning depends on the product category (e.g. "optikai" = "optical" in both mouse sensors and audio inputs, but the appropriate English phrase differs).\n` +
      `- If an item has no sensible translation or is already in ${params.targetLanguage}, return it unchanged.\n` +
      `- Return a JSON object with a "translations" array. Each entry must have the exact original "source" string (as given in the input) and its "translation".`;

    const userPrompt = JSON.stringify({ items: params.texts });

    const startedAt = Date.now();

    let response;
    try {
      response = await this.aiChat.createChat({
        costLabel: 'translation',
        schema: BATCH_TRANSLATION_SCHEMA,
        schemaName: 'batch_translation',
        model: params.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 1,
      });
    } catch (error) {
      this.metrics.recordLlmCall({
        sourceLanguage: params.sourceLanguage,
        targetLanguage: params.targetLanguage,
        chunkSize: params.texts.length,
        durationSeconds: (Date.now() - startedAt) / 1000,
        status: 'error',
      });
      throw error;
    }

    this.metrics.recordLlmCall({
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
      chunkSize: params.texts.length,
      durationSeconds: (Date.now() - startedAt) / 1000,
      status: 'success',
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return new Map();

    let parsed: {
      translations?: Array<{ source: string; translation: string }>;
    };
    try {
      parsed = JSON.parse(content);
    } catch {
      this.logger.warn('Translation LLM returned invalid JSON', {
        preview: content.slice(0, 200),
      });
      return new Map();
    }

    const inputSet = new Set(params.texts);
    const result = new Map<string, string>();
    for (const entry of parsed.translations ?? []) {
      if (!entry?.source || !entry?.translation) continue;
      const translation = entry.translation.trim();
      if (!translation) continue;
      // The LLM should echo the exact input strings (already normalized) as the "source".
      // Reject keys we didn't send to guard against hallucinations.
      const normalizedSource = entry.source.toLowerCase().trim();
      if (inputSet.has(normalizedSource)) {
        result.set(normalizedSource, translation);
      }
    }

    return result;
  }
}
