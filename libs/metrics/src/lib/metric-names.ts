export const SCHEDULER_STARTED_TOTAL = 'scheduler_started_total';
export const SCHEDULER_FINISHED_TOTAL = 'scheduler_finished_total';
export const SCHEDULER_FAILED_TOTAL = 'scheduler_failed_total';

export const TASK_STARTED_TOTAL = 'task_started_total';
export const TASK_FINISHED_TOTAL = 'task_finished_total';
export const TASK_FAILED_TOTAL = 'task_failed_total';
export const TASK_DURATION_SECONDS = 'task_duration_seconds';

export const PRODUCT_IMPORT_TASK_STARTED_TOTAL = 'product_import_task_started_total';
export const PRODUCT_IMPORT_TASK_FINISHED_TOTAL = 'product_import_task_finished_total';
export const PRODUCT_IMPORT_TASK_FAILED_TOTAL = 'product_import_task_failed_total';
export const PRODUCT_IMPORT_TASK_DURATION_SECONDS = 'product_import_task_duration_seconds';
/** Import tasks this collector is running right now: every tick adds up to a batch. */
export const PRODUCT_IMPORT_TASK_IN_FLIGHT = 'product_import_task_in_flight';

export const NEW_PRODUCT_CREATED = 'new_product_created_total';
export const PRODUCT_UPDATED = 'product_updated_total';
export const PRODUCT_IMAGE_CREATED = 'product_image_created_total';
export const PRODUCT_SPEC_VALIDATION_FAILED =
  'product_spec_validation_failed_total';

export const OPENAI_CHAT_COMPLETION_TOTAL = 'openai_chat_completion_total';
export const OPENAI_CHAT_COMPLETION_DURATION_SECONDS =
  'openai_chat_completion_duration_seconds';
export const OPENAI_CHAT_COMPLETION_TOKENS_TOTAL =
  'openai_chat_completion_tokens_total';

// Provider-agnostic AI chat metrics. Labels include `provider` so dashboards
// can split openai vs. gemini. The legacy openai_* series above is still
// emitted by OpenAiMetricsService for one release so existing dashboards
// keep working.
export const AI_CHAT_COMPLETION_TOTAL = 'ai_chat_completion_total';
export const AI_CHAT_COMPLETION_DURATION_SECONDS =
  'ai_chat_completion_duration_seconds';
export const AI_CHAT_COMPLETION_TOKENS_TOTAL =
  'ai_chat_completion_tokens_total';

// Product search metrics
export const PRODUCT_RESOLUTION_WEB_SEARCH_TOTAL =
  'product_resolution_web_search_total';
export const PRODUCT_RESOLUTION_WEB_SEARCH_DURATION_SECONDS =
  'product_resolution_web_search_duration_seconds';
export const PRODUCT_RESOLUTION_WEB_SEARCH_CACHE_TOTAL =
  'product_resolution_web_search_cache_total';
export const PRODUCT_RESOLUTION_WEB_SEARCH_RESULTS =
  'product_resolution_web_search_results';

// Public API metrics
export const HTTP_REQUESTS_TOTAL = 'http_requests_total';
export const HTTP_REQUEST_DURATION_SECONDS = 'http_request_duration_seconds';
export const SEARCH_QUERIES_TOTAL = 'search_queries_total';
export const SEARCH_ZERO_RESULTS_TOTAL = 'search_zero_results_total';
export const DB_QUERY_DURATION_SECONDS = 'db_query_duration_seconds';
export const RECAPTCHA_REJECTIONS_TOTAL = 'recaptcha_rejections_total';
export const DYNAMIC_CONFIG_RELOADS_TOTAL = 'dynamic_config_reloads_total';

// Full sync metrics
export const FULL_SYNC_TOTAL = 'full_sync_total';
export const FULL_SYNC_DURATION_SECONDS = 'full_sync_duration_seconds';
export const FULL_SYNC_CATEGORIES_DISCOVERED_TOTAL =
  'full_sync_categories_discovered_total';
export const FULL_SYNC_LIST_TASKS_CREATED_TOTAL =
  'full_sync_list_tasks_created_total';

// Zyte HTTP scraper metrics
export const ZYTE_SCRAPE_TOTAL = 'zyte_scrape_total';
export const ZYTE_SCRAPE_DURATION_SECONDS = 'zyte_scrape_duration_seconds';

// Native (unpaid) fetching, kept as its own series so 'did this source stop
// costing us Zyte requests?' is a query rather than an inference.
export const NATIVE_SCRAPE_TOTAL = 'native_scrape_total';
export const NATIVE_SCRAPE_DURATION_SECONDS = 'native_scrape_duration_seconds';

// Import task queue depth
export const PRODUCT_IMPORT_TASK_QUEUE_DEPTH = 'product_import_task_queue_depth';
/**
 * A queued feed row its task no longer imports, by reason: the source's config
 * changed between the feed run and the task (a category turned off, a filter
 * tightened). A steady rate means runs queue rows the config then rejects.
 */
export const FEED_ENTRY_SKIPPED_TOTAL = 'feed_entry_skipped_total';

// List page scraper metrics
export const LIST_PAGE_PRODUCTS_FOUND_TOTAL =
  'list_page_products_found_total';
export const LIST_PAGE_PRODUCTS_SKIPPED_TOTAL =
  'list_page_products_skipped_total';
export const LIST_PAGE_DETAIL_TASKS_CREATED_TOTAL =
  'list_page_detail_tasks_created_total';

// Extended product outcome metrics
export const PRODUCT_MATCHED_TOTAL = 'product_matched_total';
export const PRODUCT_ALIAS_CREATED_TOTAL = 'product_alias_created_total';
export const PRODUCT_BRAND_RESOLUTION_FAILED_TOTAL =
  'product_brand_resolution_failed_total';
export const SCRAPE_RESOLUTION_OUTCOME_TOTAL = 'scrape_resolution_outcome_total';
/**
 * Two things claiming one offer identity.
 *
 * Its own series because every kind it counts fails SILENTLY — the unique
 * constraint on (seller, externalId) does not error on a collision, it just
 * keeps the last writer. Without a counter, lost variants and cross-source
 * identity disagreements are invisible until somebody notices a product has
 * one offer where it used to have four.
 */
export const OFFER_IDENTITY_CONFLICT_TOTAL = 'offer_identity_conflict_total';
/**
 * Every scraped offer's GTIN, by whether it survived normalizeGtin.
 *
 * An invalid value is dropped rather than stored, which is correct and
 * invisible — a source whose barcodes suddenly all fail (a mapping pointing at
 * the wrong field, a shop switching to internal codes) would otherwise just
 * quietly stop matching across shops.
 */
export const OFFER_GTIN_TOTAL = 'offer_gtin_total';
/**
 * A listing's identifier (declared sibling, GTIN, MPN) found a product the
 * listing could not attach to: several products, another brand, or a primary
 * spec contradiction. The listing went on to name matching and a pair was
 * opened — a rising rate means a shop's identifiers stopped being trustworthy.
 */
export const IDENTITY_KEY_CONFLICT_TOTAL = 'identity_key_conflict_total';
/**
 * A listing resolved one way (its own history, or an earlier identifier tier)
 * while a later identifier pointed at a different product. The listing stays
 * where it was resolved; the pair it opens is the duplicate to merge.
 */
export const IDENTITY_KEY_DISAGREEMENT_TOTAL = 'identity_key_disagreement_total';
/**
 * A listing that resolved to "create a product", then, re-checked under its
 * brand's lock, found the product a concurrent import had just created, and
 * attached to it instead. By the tier that found it. Every count here is a
 * duplicate product that parallel imports would otherwise have made.
 */
export const IDENTITY_RECHECK_ATTACHED_TOTAL = 'identity_recheck_attached_total';
/**
 * The LLM identity extraction, per listing: extracted fresh, reused because
 * the listing's input did not change, failed (the listing continues on its
 * deterministic data), or disabled for the source. On a nightly re-import of
 * an unchanged catalogue, everything should land in `reused`.
 */
export const IDENTITY_EXTRACTION_TOTAL = 'identity_extraction_total';
/**
 * Spec-table rows the source's identityExtraction.specRows let through, per
 * listing. A source whose listings suddenly match none has renamed its labels;
 * the extraction would then see the title alone and fill far fewer specs.
 */
export const IDENTITY_SPEC_ROWS_MATCHED = 'identity_spec_rows_matched';
/**
 * Full spec unification, which runs once per product per source: when a
 * listing creates a product, or when a source first contributes to one.
 */
export const SPEC_UNIFICATION_TOTAL = 'spec_unification_total';

// Detail page extraction metrics
export const DETAIL_EXTRACTION_OUTCOME_TOTAL =
  'detail_extraction_outcome_total';
export const DETAIL_EXTRACTION_SKIP_REASON_TOTAL =
  'detail_extraction_skip_reason_total';
export const DETAIL_SCRAPE_DURATION_SECONDS =
  'detail_scrape_duration_seconds';
export const DETAIL_EXTRACTION_DURATION_SECONDS =
  'detail_extraction_duration_seconds';

// Per-source spec validation
export const PRODUCT_SOURCE_SPEC_VALIDATION_FAILED_TOTAL =
  'product_source_spec_validation_failed_total';

// Image copy metrics
export const PRODUCT_IMAGE_COPY_TOTAL = 'product_image_copy_total';

// Translation service metrics
export const TRANSLATION_BATCH_TOTAL = 'translation_batch_total';
export const TRANSLATION_BATCH_DURATION_SECONDS =
  'translation_batch_duration_seconds';
export const TRANSLATION_ITEMS_TOTAL = 'translation_items_total';
export const TRANSLATION_LLM_CALL_TOTAL = 'translation_llm_call_total';
export const TRANSLATION_LLM_CALL_DURATION_SECONDS =
  'translation_llm_call_duration_seconds';
export const TRANSLATION_LLM_CHUNK_SIZE = 'translation_llm_chunk_size';
