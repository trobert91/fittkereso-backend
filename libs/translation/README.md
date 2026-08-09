# translation

Batched translation service with dictionary, DB cache, and LLM fallback.

Entry point: `TranslationService.translateBatch()` — takes a list of strings,
returns a `Map<normalized, translated>` plus a sync `lookup()` helper.

Lookup chain per call:

1. Dictionary (from `libs/config/src/lib/configs/translation.json`)
2. DB cache (`translation_cache` table)
3. LLM call (OpenAI `gpt-5.4-nano` by default) — only if anything is still unknown

LLM results are written back to the cache so subsequent batches get free hits.
