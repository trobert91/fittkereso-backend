export const SCHEDULER_STARTED_TOTAL = 'scheduler_started_total';
export const SCHEDULER_FINISHED_TOTAL = 'scheduler_finished_total';
export const SCHEDULER_FAILED_TOTAL = 'scheduler_failed_total';

export const TASK_STARTED_TOTAL = 'task_started_total';
export const TASK_FINISHED_TOTAL = 'task_finished_total';
export const TASK_FAILED_TOTAL = 'task_failed_total';
export const TASK_DURATION_SECONDS = 'task_duration_seconds';

export const SCRAPE_TASK_STARTED_TOTAL = 'scrape_task_started_total';
export const SCRAPE_TASK_FINISHED_TOTAL = 'scrape_task_finished_total';
export const SCRAPE_TASK_FAILED_TOTAL = 'scrape_task_failed_total';
export const SCRAPE_TASK_DURATION_SECONDS = 'scrape_task_duration_seconds';

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

// Incremental sync metrics
export const INCREMENTAL_SYNC_TOTAL = 'incremental_sync_total';
export const INCREMENTAL_SYNC_DURATION_SECONDS =
  'incremental_sync_duration_seconds';
export const INCREMENTAL_SYNC_KEYWORDS_SEARCHED_TOTAL =
  'incremental_sync_keywords_searched_total';
export const INCREMENTAL_SYNC_URLS_DISCOVERED_TOTAL =
  'incremental_sync_urls_discovered_total';
export const INCREMENTAL_SYNC_URLS_CLASSIFIED_TOTAL =
  'incremental_sync_urls_classified_total';
export const INCREMENTAL_SYNC_URLS_DEDUPLICATED_TOTAL =
  'incremental_sync_urls_deduplicated_total';
export const INCREMENTAL_SYNC_TASKS_CREATED_TOTAL =
  'incremental_sync_tasks_created_total';

// Exa API metrics
export const EXA_API_CALL_TOTAL = 'exa_api_call_total';
export const EXA_API_DURATION_SECONDS = 'exa_api_duration_seconds';

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

// Scrape task queue depth
export const SCRAPE_TASK_QUEUE_DEPTH = 'scrape_task_queue_depth';

// List page scraper metrics
export const LIST_PAGE_PRODUCTS_FOUND_TOTAL =
  'list_page_products_found_total';
export const LIST_PAGE_PRODUCTS_SKIPPED_TOTAL =
  'list_page_products_skipped_total';
export const LIST_PAGE_DETAIL_TASKS_CREATED_TOTAL =
  'list_page_detail_tasks_created_total';

// Duplicate detection metrics
export const DUPLICATE_PAIRS_DETECTED_TOTAL = 'duplicate_pairs_detected_total';
export const DUPLICATE_AUTO_MERGED_TOTAL = 'duplicate_auto_merged_total';
export const DUPLICATE_PENDING_REVIEW_TOTAL = 'duplicate_pending_review_total';
export const DUPLICATE_SKIPPED_TOTAL = 'duplicate_skipped_total';
export const DUPLICATE_DETECTION_DURATION_SECONDS =
  'duplicate_detection_duration_seconds';
export const DUPLICATE_SIMILARITY_SCORE = 'duplicate_similarity_score';

// Extended product outcome metrics
export const PRODUCT_MATCHED_TOTAL = 'product_matched_total';
export const PRODUCT_ALIAS_CREATED_TOTAL = 'product_alias_created_total';
export const PRODUCT_BRAND_RESOLUTION_FAILED_TOTAL =
  'product_brand_resolution_failed_total';
export const SCRAPE_RESOLUTION_OUTCOME_TOTAL = 'scrape_resolution_outcome_total';

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
