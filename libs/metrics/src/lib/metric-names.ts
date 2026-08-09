export const REDDIT_SEARCH_QUERY_PROCESSED =
  'reddit_search_query_processed_total';

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

export const THREAD_CREATED = 'new_thread_created_total';
export const THREAD_PREPROCESSED = 'new_thread_preprocessed_total';
export const THREAD_CATEGORY_NOT_FOUND = 'thread_category_not_found_total';
export const THREAD_RELEVANCE = 'thread_relevance';
export const THREAD_PROCESSING_STARTED_TOTAL =
  'thread_processing_started_total';
export const THREAD_RELEVANCE_CALCULATION_TOTAL =
  'thread_relevance_calculation_total';
export const THREAD_RELEVANCE_CALCULATION_DURATION_SECONDS =
  'thread_relevance_calculation_duration_seconds';

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

// Product resolution metrics
export const PRODUCT_RESOLUTION_OUTCOME_TOTAL = 'product_resolution_total';

// Product search metrics
export const PRODUCT_RESOLUTION_WEB_SEARCH_TOTAL =
  'product_resolution_web_search_total';
export const PRODUCT_RESOLUTION_WEB_SEARCH_DURATION_SECONDS =
  'product_resolution_web_search_duration_seconds';
export const PRODUCT_RESOLUTION_WEB_SEARCH_CACHE_TOTAL =
  'product_resolution_web_search_cache_total';
export const PRODUCT_RESOLUTION_WEB_SEARCH_RESULTS =
  'product_resolution_web_search_results';

// Pipeline metrics
export const PIPELINE_RELEVANCE_SCORE = 'pipeline_relevance_score';
export const PIPELINE_RELEVANCE_OUTCOME_TOTAL =
  'pipeline_relevance_outcome_total';
export const PIPELINE_MODERATION_OUTCOME_TOTAL =
  'pipeline_moderation_outcome_total';
export const PIPELINE_THREAD_COST = 'pipeline_thread_processing_cost';

// Batched pipeline metrics
export const PIPELINE_SUBTREE_EXTRACTION_TOTAL =
  'pipeline_subtree_extraction_total';
export const PIPELINE_SUBTREE_EXTRACTION_DURATION_SECONDS =
  'pipeline_subtree_extraction_duration_seconds';
export const PIPELINE_SUBTREE_EXTRACTION_PLAN_NODES =
  'pipeline_subtree_extraction_plan_nodes';
export const PIPELINE_SUBTREE_EXTRACTION_MISS_RATE =
  'pipeline_subtree_extraction_miss_rate';
export const PIPELINE_SUBTREE_EXTRACTION_RETRY_TOTAL =
  'pipeline_subtree_extraction_retry_total';
export const PIPELINE_SUBTREE_EXTRACTION_COST =
  'pipeline_subtree_extraction_cost';
export const PIPELINE_SUBTREE_VALIDATION_TOTAL =
  'pipeline_subtree_validation_total';
export const PIPELINE_SUBTREE_VALIDATION_DURATION_SECONDS =
  'pipeline_subtree_validation_duration_seconds';
export const PIPELINE_VALIDATION_OUTCOME_TOTAL =
  'pipeline_validation_outcome_total';
export const PIPELINE_VALIDATION_FAST_PATH_TOTAL =
  'pipeline_validation_fast_path_total';
export const PIPELINE_SUBTREE_VALIDATION_COST =
  'pipeline_subtree_validation_cost';
export const PIPELINE_OP_SUMMARIZATION_TOTAL =
  'pipeline_op_summarization_total';
export const PIPELINE_THREAD_SUBTREE_COUNT =
  'pipeline_thread_subtree_count';
export const PIPELINE_THREAD_PHASE_DURATION_SECONDS =
  'pipeline_thread_phase_duration_seconds';
export const PIPELINE_THREAD_PROCESSING_DURATION_SECONDS =
  'pipeline_thread_processing_duration_seconds';
export const PIPELINE_REGISTRY_PRODUCT_COUNT =
  'pipeline_registry_product_count';
export const PIPELINE_REGISTRY_CHEAT_SHEET_CHARS =
  'pipeline_registry_cheat_sheet_chars';

// Public API metrics
export const HTTP_REQUESTS_TOTAL = 'http_requests_total';
export const HTTP_REQUEST_DURATION_SECONDS = 'http_request_duration_seconds';
export const SEARCH_QUERIES_TOTAL = 'search_queries_total';
export const SEARCH_ZERO_RESULTS_TOTAL = 'search_zero_results_total';
export const DB_QUERY_DURATION_SECONDS = 'db_query_duration_seconds';
export const RECAPTCHA_REJECTIONS_TOTAL = 'recaptcha_rejections_total';
export const DYNAMIC_CONFIG_RELOADS_TOTAL = 'dynamic_config_reloads_total';

// Deferred resolution metrics
export const PIPELINE_DEFERRED_RESOLUTION_TOTAL =
  'pipeline_deferred_resolution_total';
export const PIPELINE_DEFERRED_RESOLUTION_DURATION_SECONDS =
  'pipeline_deferred_resolution_duration_seconds';
export const PIPELINE_DEFERRED_RESOLUTION_BATCH_SIZE =
  'pipeline_deferred_resolution_batch_size';
export const PIPELINE_DEFERRED_REFS_CLASSIFIED_TOTAL =
  'pipeline_deferred_refs_classified_total';

// Thread search — scheduler
export const THREAD_SEARCH_CYCLE_TOTAL = 'thread_search_cycle_total';
export const THREAD_SEARCH_CYCLE_DURATION_SECONDS =
  'thread_search_cycle_duration_seconds';
export const THREAD_SEARCH_TASKS_CREATED_TOTAL =
  'thread_search_tasks_created_total';
export const THREAD_SEARCH_CATEGORIES_SEARCHED_TOTAL =
  'thread_search_categories_searched_total';
export const THREAD_SEARCH_BUDGET_UTILIZATION =
  'thread_search_budget_utilization';

// Thread search — execution
export const THREAD_SEARCH_EXECUTED_TOTAL = 'thread_search_executed_total';
export const THREAD_SEARCH_DURATION_SECONDS =
  'thread_search_duration_seconds';
export const THREAD_SEARCH_DISCOVERED_TOTAL =
  'thread_search_discovered_total';
export const THREAD_SEARCH_DUPLICATES_TOTAL =
  'thread_search_duplicates_total';
export const THREAD_SEARCH_REJECTED_TOTAL = 'thread_search_rejected_total';
export const THREAD_SEARCH_BELOW_QUALITY_GATE_TOTAL =
  'thread_search_below_quality_gate_total';
export const THREAD_SEARCH_AVERAGE_RELEVANCE =
  'thread_search_average_relevance';
export const THREAD_SEARCH_EARLY_STOP_TOTAL =
  'thread_search_early_stop_total';

// Thread search — keywords
export const THREAD_SEARCH_KEYWORD_YIELD_RATE =
  'thread_search_keyword_yield_rate';
export const THREAD_SEARCH_KEYWORDS_GENERATED_TOTAL =
  'thread_search_keywords_generated_total';

// Thread search — platform
export const THREAD_SEARCH_PLATFORM_API_DURATION_SECONDS =
  'thread_search_platform_api_duration_seconds';
export const THREAD_SEARCH_PLATFORM_API_ERROR_TOTAL =
  'thread_search_platform_api_error_total';

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
