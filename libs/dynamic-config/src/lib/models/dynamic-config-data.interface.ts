export interface GeneralConfig {
  threadProcessingPerDay: number;
  redditSearchThreadLimit: number;
  redditThreadExpiryInDays: number;
  adminContactEmail?: string;
  amazonAffiliateTag?: string;
}

export interface ProductSearchAgentConfig {
  /** Maximum entries in context.modelVariants across all iterations. Default: 20 */
  maxModelVariants?: number;
  /** Maximum candidate pool size after each merge. Default: 50 */
  maxCandidates?: number;
  /** When true, the candidate pre-filter (CandidatePreFilterService) drops candidates
   *  that violate effectiveMatchSpecs or the category constraint before the matcher
   *  and contextual-resolution agents run. Set to false for rollback to pre-WI-4
   *  behavior. Default: true. */
  preFilterEnabled?: boolean;
  /** When true, the WI 7 SERP-evidence pipeline runs alongside today's extraction:
   *  build SearchEvidence[] from each SERP fetch, run per-record model-number
   *  extraction, and re-search the catalog for the extracted SKUs. Set to false
   *  to disable for emergency rollback. Default: true. */
  serpEvidenceEnabled?: boolean;
  /** Conservative acceptance threshold for the decision LLM. Final decisions
   *  below this threshold are downgraded to `unresolved` with
   *  `unresolvedReason='low_confidence'` (legacy) / `reason='below_accept_threshold'`
   *  (new lib).
   *
   *  Scale depends on which lib reads it:
   *  - `libs/product-resolution` (legacy): 0–1 float. Default: 0.5.
   *  - `libs/product-search` (new): 0–100 integer. Default: 50.
   *
   *  Stage 7 (cutover) flips `resolution.json` to set this to `50` and the
   *  legacy lib is removed. Until then, leave the JSON value unset so each lib
   *  uses its own default.
   *
   *  @deprecated Use `resolution.matching.acceptThreshold` /
   *  `acceptThresholdStrict` (mode-aware). The decision LLM now reads the
   *  matcher's threshold pair via `MatchingConfigService` so the matcher and
   *  the LLM share a single source of truth. This field is no longer consumed
   *  by the resolution pipeline and will be removed in a follow-up. */
  acceptThreshold?: number;
  /** LLM model used by ProductResolutionDecisionService for the final
   *  decision call. Default: 'deepseek-v4-flash' */
  decisionModel?: string;
  webSearch?: {
    /** LLM model for extraction and disambiguation calls. Default: 'deepseek-v4-flash' */
    extractionModel?: string;
    /** Min confidence to accept extracted product identity. Default: 0.5 */
    minProductConfidence?: number;
    /** Min confidence to accept a cross-market variant. Default: 0.6 */
    minVariantConfidence?: number;
  };
  crossMarket?: {
    /** Max candidates shown to the LLM ranker. Default: 5 */
    topCandidates?: number;
    /** Min embedding/fuzzy confidence to include a candidate in LLM ranking. Default: 0.6 */
    minCandidateConfidence?: number;
    /** Min LLM confidence to accept a ranked cross-market match. Default: 0.7 */
    minMatchConfidence?: number;
    /** LLM model for the cross-market ranking call. Default: uses webSearch.extractionModel */
    rankingModel?: string;
  };
  /** Search result cache configuration */
  cache?: {
    enabled?: boolean;
    positiveTtlDays?: number;
    negativeTtlDays?: number;
    similarityThreshold?: number;
  };
  /** LLM disambiguation for ambiguous matches */
  llmDisambiguation?: {
    enabled?: boolean;
    model?: string;
    minConfidence?: number;
    maxCandidates?: number;
  };
}

export interface TranslationConfig {
  /** Enable LLM-backed translation. When false, only dictionary + cache lookups run. Default: true */
  enabled?: boolean;
  /** OpenAI model used for LLM translation calls. Default: deepseek-v4-flash */
  model?: string;
  /** Default source language (ISO code) if caller doesn't specify. Default: 'hu' */
  defaultSourceLanguage?: string;
  /** Default target language (ISO code) if caller doesn't specify. Default: 'en' */
  defaultTargetLanguage?: string;
  /** Cache TTL in days. Default: 365 */
  cacheTtlDays?: number;
  /** Max strings per LLM batch. Larger batches are chunked. Default: 50 */
  maxBatchSize?: number;
  /** Hardcoded translation dictionary, keyed by source language ISO code. */
  dictionary?: Record<string, Record<string, string>>;
}

interface PhaseConfig {
  model?: string;
  thinking?: boolean;
  effort?: string;
}

export interface DynamicConfigData {
  // How many threads to process per day
  threadProcessingPerDay: number;

  // Reddit thread search limit per query
  redditSearchThreadLimit: number;

  // Thread expiry in days
  redditThreadExpiryInDays: number;

  /** Resolution-input enrichment configuration. */
  enrichment?: {
    /** When true, ResolutionInputEnricher runs the rule-based subject-switch
     *  classifier (see `detectSubjectSwitch`) and clears `referenceProductId` /
     *  `referenceModel` / `modelClues` / `variantClues` when the comment
     *  switches subject. Disable for emergency rollback. Default: true. */
    subjectSwitchClassifierEnabled?: boolean;
  };

  // Processor threshold overrides
  processor?: {
    pipeline?: {
      maxIterations?: number;
      maxParentProducts?: number;
    };
    relevance?: {
      opBypassScore?: number;
      minApprovalScore?: number;
      webSearchMinRelevance?: number;
      minReferenceEnabledScore?: number;
    };
    moderation?: {
      maxReferenceFlags?: number;
      minAutoApprovalScore?: number;
      enableStructuredFixes?: boolean;
      /** Cumulative-severity trigger for `in_review` decision. Default: 50. */
      openSeverityReviewThreshold?: number;
      /** Saturating cap for severity normalization in `moderationPriority`. Default: 200. */
      severityCap?: number;
      /** Relevance floor above which an unresolved reference triggers in_review. Default: 50. */
      highRelevanceThreshold?: number;
    };
    relevanceCalculation?: {
      commentFetchLimit?: number;
      commentSampleSize?: number;
      minWeightedScore?: number;
      overFetchMultiplier?: number;
      model?: string;
      thinking?: boolean;
      effort?: string;
      compositeScoring?: {
        llmWeight?: number;
        recencyWeight?: number;
        recencyHalfLifeDays?: number;
        lowCommentThreshold?: number;
        lowCommentMultiplier?: number;
        veryLowCommentThreshold?: number;
        veryLowCommentMultiplier?: number;
      };
    };
    threadSelection?: {
      candidatePoolSize?: number;
      minCategoryRelevance?: number;
      maxCategoriesPerThread?: number;
    };
    identificationBuilder?: {
      softBudget?: number;
      hardBudget?: number;
      maxPlanNodes?: number;
      maxDepth?: number;
    };
    analysisBuilder?: {
      softBudget?: number;
      hardBudget?: number;
      maxPlanNodes?: number;
      maxDepth?: number;
    };
    discovery?: PhaseConfig & { missRateRetryThreshold?: number };
    identification?: PhaseConfig & { missRateRetryThreshold?: number };
    extraction?: PhaseConfig & {
      missRateRetryThreshold?: number;
      maxFocusCategories?: number;
      maxQuotesCeiling?: number;
      maxQuotesPerProduct?: number;
      minIngestionRelevance?: number;
    };
    labeling?: PhaseConfig & { maxNodes?: number; strictSchema?: boolean };
    validation?: PhaseConfig & {
      softBudget?: number;
      hardBudget?: number;
      maxNodes?: number;
      maxDepth?: number;
    };
    opSummarizer?: PhaseConfig & { threshold?: number };
    imageAnalysis?: { model?: string };
    cheatSheet?: {
      maxProducts?: number;
      maxOpSlots?: number;
      maxChars?: number;
      minSlotsPerCategory?: number;
      lowRefThreshold?: number;
    };
  };

  // Debug trace configuration
  debug?: {
    traceEnabled?: boolean;
  };

  // Scheduling configuration

  scheduling?: {
    /** Minutes before a PROCESSING task is considered stale and eligible for re-pickup. Default: 240 (4 hours) */
    staleTaskTimeoutMinutes?: number;
    /** Minutes before a PROCESSING scrape task is considered stale and eligible for re-pickup. Default: 240 (4 hours) */
    staleScrapeTaskTimeoutMinutes?: number;
    productRating?: {
      batchLimit?: number;
    };
    productReviewAnalysis?: {
      /** Max products to enqueue per scheduler tick. Default: 25 */
      batchLimit?: number;
      /** Popularity floor — `ProductRating.totalReviewCount` must reach this. Default: 20 */
      minimumTotalReviews?: number;
      /** New active reviews since `lastSummaryGeneratedAt` required to re-analyze. Default: 20 (1 for local testing) */
      minimumNewReviewsToTrigger?: number;
      /** How many top-scoring features to include in the analysis. Default: 6 */
      topFeatureLabels?: number;
      /** How many top-scoring use cases to include in the analysis. Default: 10 */
      topUseCaseLabels?: number;
      /** How many top-scoring issues to include in the analysis. Default: 6 */
      topIssueLabels?: number;
      /** Evidence quotes per label fed to the LLM. Default: 20 */
      quotesPerLabel?: number;
      /** Max reviews loaded per analysis (ordered by reviewScore DESC). Default: 200 */
      reviewSampleSize?: number;
      /** AI provider for the analysis call. Default: 'deepseek' */
      provider?: string;
      /** AI model for the analysis call. Default: 'deepseek-v4-flash' */
      model?: string;
    };
    commentReview?: {
      batchLimit?: number;
      approvedDelayHours?: number;
      revocationDelayHours?: number;
    };
    searchQueryProcessing?: {
      chunkSize?: number;
      avgRelevanceThreshold?: number;
    };
    resolutionBackfill?: {
      enabled?: boolean;
      scoredResolution?: {
        topN?: number;
        /** Only retry references created within this many days. Default: 365 */
        retryMaxAgeDays?: number;
        cooldown?: {
          baseCooldownHours?: number;
          backoffBase?: number;
          maxCooldownHours?: number;
        };
      };
    };
    duplicateDetection?: {
      enabled?: boolean;
      /** Minimum similarity (1–100) to even consider a pair. Default: 60 */
      minSimilarityThreshold?: number;
      /** Similarity (1–100) above which auto-merge is attempted. Default: 80 */
      autoMergeThreshold?: number;
      /** Minimum in-process score (1–100) to store a pair as pending_review. Pairs below this are discarded. Default: 50 */
      minPendingReviewThreshold?: number;
      /** Max non-primary spec mismatches allowed for auto-merge. Default: 2 */
      maxNonPrimaryMismatches?: number;
      /** Pairs to evaluate per category per run. Default: 100 */
      batchSize?: number;
      /** Safety cap on merges per run. Default: 50 */
      maxMergesPerRun?: number;
      /** Reference count threshold — skip auto-merge if both products exceed this. Default: 10 */
      highActivityThreshold?: number;
    };
  };

  // Product rating configuration
  rating?: {
    /** Bayesian prior weight — pulls low-N ratings toward 50. Default: 3 */
    priorWeight?: number;
    /** Bayesian prior weight for per-use-case scores. Lighter than priorWeight because use-case n is inherently small. Default: 1.5 */
    useCasePriorWeight?: number;
    /** Minimum score (0–100) for a feature highlight to surface on ProductRating. Default: 20 */
    minHighlightScore?: number;
    /** Minimum mention count for a feature highlight to be shown in the API response. Default: 2 */
    minHighlightMentions?: number;
    /** Minimum reviewScore for a review to be visible and contribute to product rating. Default: 20 */
    minReviewScore?: number;
  };

  // Review creation configuration
  review?: {
    /** Max quotes persisted on review.quotes after scoring/sort/cap. Default: 8 */
    topQuoteLimit?: number;
  };

  // Product resolution thresholds and matching weights
  resolution?: {
    embeddingSimilarityThreshold?: number;
    embeddingResultLimit?: number;
    /** Minimum reference relevance to trigger a web search during product resolution */
    webSearchRelevanceGate?: number;
    matching?: {
      acceptThreshold?: number;
      acceptThresholdStrict?: number;
      ambiguityGap?: number;
      /** Minimum matchScore (0-100) for a non-primary candidate to be persisted as a ProductReferenceCandidate. Primary candidate is always persisted regardless. Default: 50 */
      minCandidateScore?: number;
      defaultStrictness?: "strict" | "moderate" | "loose";
      defaultNumericTokenWeight?: number;
      /** Used by product-normalizer for token importance filtering */
      importantTokenWeightThreshold?: number;
      /** Hard cap on how many picks the decision LLM may return. Bounds prompt
       *  cost and downstream candidate fan-out. Default: 6 */
      maxLlmPicks?: number;
    };
    aliasAutoCreate?: {
      /** Master switch for alias auto-creation in thread-extraction resolution (match + web variants). Dedup merge is unaffected. Default: false */
      enabled?: boolean;
      /** Minimum match score (0-100) to auto-create an alias from ProductMatcherService. Default: 80 */
      minScore?: number;
    };
    // ProductSearchAgent configuration
    search?: ProductSearchAgentConfig;
  };

  // Comment/reference relevance scoring parameters
  relevance?: {
    fuzzyThreshold?: number;
    productTermCap?: number;
    searchSimilarityThreshold?: number;
    quoteQualityWeights?: {
      high?: number;
      medium?: number;
      low?: number;
    };
    experienceConfig?: {
      owner?: { multiplier?: number; floor?: number };
      priorOwner?: { multiplier?: number; floor?: number };
      tested?: { multiplier?: number; floor?: number };
      prospectiveBuyer?: { multiplier?: number; floor?: number };
      reference?: { multiplier?: number; floor?: number };
    };
  };

  // Scoring algorithm parameters
  scoring?: {
    quoteScoring?: {
      positiveNegativeRoleScore?: number;
      neutralRoleScore?: number;
      lowInfoPenalty?: number;
      lowInfoMinLength?: number;
      phraseScoreMultiplier?: number;
      lengthFactorDivisor?: number;
      quoteCountLogBase?: number;
      quoteBlendWeight?: number;
      expectedMax?: number;
      fuzzyThreshold?: number;
    };
    textScoring?: {
      expectedMax?: number;
    };
    deliberation?: {
      fuzzyThreshold?: number;
      phraseBoostMultiplier?: number;
      saturationDivisor?: number;
      maxMultiplierBoost?: number;
    };
    categoryRelevance?: {
      topKeywordCount?: number;
      fuzzyThreshold?: number;
      categoryNameWeight?: number;
      categoryAliasWeight?: number;
      keywordIdentifierWeight?: number;
      phraseBoostBase?: number;
      referenceMatchesPerTerm?: number;
      referenceWeightPerTerm?: number;
      referenceCorpusDivisor?: number;
      exclusiveTermBoost?: number;
      negativeTermFloor?: number;
    };
    priorityConfig?: {
      distanceDecay?: number;
      relevanceWeight?: number;
      mentionWeight?: number;
      recencyBoostEnabled?: boolean;
      recencyBoost24h?: number;
      recencyBoost7d?: number;
      parentPriorityRelevanceBlend?: number;
      relativeBoostMinRatio?: number;
      relativeBoostTarget?: number;
    };
    /** Weighted consolidation parameters for ReviewLabel.sentiment (see deriveLabels). */
    labelConsolidation?: {
      /** Net signal (|P-N|) required to commit to Strong{Positive,Negative}. Default 1.5. */
      strongThreshold?: number;
      /** Net signal required to commit to Positive/Negative. Default 0.5. */
      positiveThreshold?: number;
      /** Minimum strong-pos / strong-neg pool size to lock in Mixed. Default 1.0. */
      minStrongMixed?: number;
      /** Multiplier applied to each entry's contribution by quote quality tier. */
      qualityWeights?: { high?: number; medium?: number; low?: number };
      /** Weight assigned to ref-level evidence entries (no quote, no quality). Default 1.0. */
      refLevelQualityWeight?: number;
    };
  };

  // OpenAI pricing and retry configuration
  openai?: {
    pricing?: Record<
      string,
      {
        inputPerMillion: number;
        cachedInputPerMillion?: number;
        outputPerMillion: number;
      }
    >;
    maxRetries?: number;
    fallbackModel?: string;
  };

  // Gemini pricing and retry configuration
  gemini?: {
    pricing?: Record<
      string,
      {
        inputPerMillion: number;
        cachedInputPerMillion?: number;
        outputPerMillion: number;
      }
    >;
    maxRetries?: number;
    fallbackModel?: string;
  };

  // Claude (Anthropic) pricing and retry configuration
  claude?: {
    pricing?: Record<
      string,
      {
        inputPerMillion: number;
        cachedInputPerMillion?: number;
        outputPerMillion: number;
      }
    >;
    maxRetries?: number;
    fallbackModel?: string;
  };

  // OpenRouter pricing and retry configuration
  openrouter?: {
    pricing?: Record<
      string,
      {
        inputPerMillion: number;
        cachedInputPerMillion?: number;
        outputPerMillion: number;
      }
    >;
    maxRetries?: number;
    fallbackModel?: string;
  };

  // DeepSeek pricing and retry configuration
  deepseek?: {
    pricing?: Record<
      string,
      {
        inputPerMillion: number;
        cachedInputPerMillion?: number;
        outputPerMillion: number;
      }
    >;
    maxRetries?: number;
    fallbackModel?: string;
  };

  // Translation service configuration
  translation?: TranslationConfig;

  // Web search configuration
  webSearch?: {
    /** Default provider: 'dataforseo' or 'exa' (null = use providerSelection logic) */
    defaultProvider?: "dataforseo" | "exa";

    /** Provider selection strategy for hybrid mode */
    providerSelection?: {
      /** Use Exa.ai for OP (original post) comments */
      useExaForOp?: boolean;
      /** Minimum relevance score to use Exa (0-1) */
      minRelevanceForExa?: number;
    };

    /** Cache configuration */
    cache?: {
      /** Enable/disable caching */
      enabled?: boolean;
      /** Min keyword similarity for cache hit (0-1) */
      similarityThreshold?: number;
      /** Date tolerance window in days (±) */
      dateToleranceDays?: number;
      /** Cache entry TTL in days */
      ttlDays?: number;
    };

    /** DataForSEO provider configuration */
    dataforseo?: {
      /** Number of results to fetch */
      maxResults?: number;
    };

    /** Exa.ai provider configuration */
    exa?: {
      /** Number of results to fetch */
      numResults?: number;
      /** Let Exa optimize the search query */
      useAutoprompt?: boolean;
      /** Search type: 'neural' for semantic, 'keyword' for traditional */
      type?: "neural" | "keyword";
      /** Include full page content in results */
      includeContent?: boolean;
    };
  };

  // Reprocessing configuration for re-running EXTRACTED threads
  reprocessing?: {
    /** Enable re-processing of EXTRACTED threads. Default: false */
    enabled?: boolean;
    /** Re-process threads last processed more than this many days ago. Default: 30 */
    reprocessAfterDays?: number;
    /** Fraction of threadProcessingPerDay budget reserved for reprocessing. Default: 0.2 */
    dailyBudgetFraction?: number;
    /** Max threads to reprocess per scheduler cycle. Default: 3 */
    maxReprocessPerCycle?: number;
  };

  // Preprocessing configuration for thread ingestion
  preprocessing?: {
    /** Minimum Reddit upvote score for a submission to be ingested. Default: 15 */
    minScore?: number;
    /** Minimum comment count for a submission to be ingested. Default: 8 */
    minComments?: number;
    /** Minimum relevance score for a thread to be kept after preprocessing. Threads below this are deleted. Default: 40 */
    minRelevanceForIngestion?: number;
  };

  // Keyword-research scheduler — LLM-driven keyword planner that replaces the
  // legacy template + weighted-lottery keyword pipeline.
  keywordResearch?: {
    /** Global keyword budget allocated across enabled categories per scheduler run. Default: 100 */
    totalKeywordsPerRun?: number;
    /** Safety cap: max keywords a single category can receive in one run. Default: 20 */
    maxKeywordsPerCategory?: number;
    /** Floor: each eligible category gets at least this many keywords (subject to budget availability). Default: 2 */
    minKeywordsPerCategory?: number;
    /** Backlog size (SELECTED count per category) at which deficitScore reaches 0. Default: 100 */
    targetBacklog?: number;
    /** Days a keyword stays in cooldown after a search. Default: 21 */
    cooldownDays?: number;
    /** Over-fetch multiplier — the planner is asked for `ceil(allocatedCount * x)` keywords so cooldown drops still leave us at target. Default: 1.5 */
    overFetchMultiplier?: number;
    /** Number of top products sampled and shown to the LLM for comparison keywords. Default: 12 */
    topProductSampleSize?: number;
    /** History window for keyword yield stats fed to the LLM (weeks). Default: 8 */
    yieldHistoryWeeks?: number;
    /** AI model for the planner call. Default: 'deepseek-v4-flash' */
    plannerModel?: string;
    /** Delay in seconds before retrying rate-limited Reddit calls. Default: 60 */
    rateLimitBackoffSeconds?: number;
    /** Max pending ThreadSearchTask rows drained by the dedicated scheduler per 10-minute tick. Default: 5 */
    schedulerBatchSize?: number;
    /** Reddit search 'time' parameter applied to every search (scoped and broad). Default: 'year' */
    searchTime?: string;
    /** Reddit search 'limit' (max results per query) applied to every search. Default: 400 */
    searchLimit?: number;
    /** Stricter min upvote score for the Reddit-wide (scope=null) pass. Default: 30 */
    broadSearchMinScore?: number;
    /** Stricter min comment count for the Reddit-wide pass. Default: 15 */
    broadSearchMinComments?: number;
    /** Stricter min relevance for ingestion during the Reddit-wide pass. Default: 60 */
    broadSearchMinRelevance?: number;
    /** Stricter early-stop avg-relevance threshold during the Reddit-wide pass. Default: 60 */
    broadSearchAvgRelevanceThreshold?: number;
  };

  // Contact form + feedback notifications
  adminContactEmail?: string;

  // Amazon Associates tag (e.g. "ebike-20")
  amazonAffiliateTag?: string;
}

export const dynamicConfigSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    threadProcessingPerDay: {
      type: "number",
      minimum: 0,
      description: "How many threads to process per day.",
    },
    redditSearchThreadLimit: {
      type: "number",
      minimum: 1,
      description:
        "Maximum number of threads the system should search for per query.",
    },
    redditThreadExpiryInDays: {
      type: "number",
      minimum: 1,
      description: "Number of days after which a thread is considered expired.",
    },
    processor: {
      type: "object",
      additionalProperties: true,
      description: "Processor threshold overrides.",
      properties: {
        pipeline: {
          type: "object",
          properties: {
            maxIterations: { type: "number", minimum: 1 },
            maxParentProducts: { type: "number", minimum: 1 },
          },
        },
        relevance: {
          type: "object",
          properties: {
            opBypassScore: { type: "number", minimum: 0 },
            minApprovalScore: { type: "number", minimum: 0, maximum: 100 },
            webSearchMinRelevance: {
              type: "number",
              minimum: 0,
              maximum: 100,
            },
            minReferenceEnabledScore: {
              type: "number",
              minimum: 0,
              maximum: 100,
            },
          },
        },
        moderation: {
          type: "object",
          properties: {
            maxReferenceFlags: { type: "number", minimum: 0 },
            minAutoApprovalScore: { type: "number", minimum: 0, maximum: 100 },
            enableStructuredFixes: { type: "boolean" },
            openSeverityReviewThreshold: { type: "number", minimum: 0 },
            severityCap: { type: "number", minimum: 1 },
          },
        },
        relevanceCalculation: {
          type: "object",
          additionalProperties: true,
          description:
            "Thread relevance calculation (LLM-based pre-screening) configuration.",
          properties: {
            commentFetchLimit: {
              type: "number",
              minimum: 1,
              maximum: 200,
              description: "Max comments to fetch from Reddit API. Default: 60",
              default: 60,
            },
            commentSampleSize: {
              type: "number",
              minimum: 1,
              maximum: 100,
              description:
                "Max comments to include in the LLM prompt. Default: 30",
              default: 30,
            },
            minWeightedScore: {
              type: "number",
              minimum: 1,
              maximum: 100,
              description:
                "Minimum weighted score threshold (1-100 scale). Default: 40",
              default: 40,
            },
            overFetchMultiplier: {
              type: "number",
              minimum: 1,
              maximum: 10,
              description:
                "Fetch budget * multiplier candidates to account for skips. Default: 3",
              default: 3,
            },
            model: {
              type: "string",
              description:
                "LLM model for relevance calculation. Default: deepseek-v4-flash",
              default: "deepseek-v4-flash",
            },
            thinking: {
              type: "boolean",
              description:
                "Enable provider reasoning/thinking. Default: true. Set false to disable for faster, cheaper calls.",
              default: true,
            },
            effort: {
              type: "string",
              description:
                'Provider-specific reasoning effort ("low" | "medium" | "high" | "max"). Default: high. Ignored when thinking is false.',
              default: "high",
            },
            compositeScoring: {
              type: "object",
              additionalProperties: false,
              description:
                "Weights and parameters for composite score blending.",
              properties: {
                llmWeight: {
                  type: "number",
                  minimum: 0,
                  maximum: 1,
                  default: 0.85,
                },
                recencyWeight: {
                  type: "number",
                  minimum: 0,
                  maximum: 1,
                  default: 0.15,
                },
                recencyHalfLifeDays: {
                  type: "number",
                  minimum: 1,
                  default: 180,
                },
                lowCommentThreshold: {
                  type: "number",
                  minimum: 0,
                  default: 20,
                },
                lowCommentMultiplier: {
                  type: "number",
                  minimum: 0,
                  maximum: 1,
                  default: 0.85,
                },
                veryLowCommentThreshold: {
                  type: "number",
                  minimum: 0,
                  default: 10,
                },
                veryLowCommentMultiplier: {
                  type: "number",
                  minimum: 0,
                  maximum: 1,
                  default: 0.7,
                },
              },
            },
          },
        },
        threadSelection: {
          type: "object",
          additionalProperties: false,
          description:
            "LLM-based thread selection configuration: category candidate pool, category confidence threshold, max categories per thread.",
          properties: {
            candidatePoolSize: {
              type: "number",
              minimum: 1,
              maximum: 20,
              description:
                "How many candidate categories to send to the LLM (pre-filtered by the cheap term scorer). Default: 4",
              default: 4,
            },
            minCategoryRelevance: {
              type: "number",
              minimum: 0,
              maximum: 100,
              description:
                "Drop categories whose LLM-assigned relevance is below this threshold. Default: 50",
              default: 50,
            },
            maxCategoriesPerThread: {
              type: "number",
              minimum: 1,
              maximum: 10,
              description:
                "Maximum number of categories to retain on a thread. Default: 3",
              default: 3,
            },
          },
        },
        identificationBuilder: {
          type: "object",
          additionalProperties: false,
          properties: {
            softBudget: { type: "number", minimum: 1000 },
            hardBudget: { type: "number", minimum: 1000 },
            maxPlanNodes: { type: "number", minimum: 1, maximum: 50 },
            maxDepth: { type: "number", minimum: 1, maximum: 20 },
          },
        },
        analysisBuilder: {
          type: "object",
          additionalProperties: false,
          properties: {
            softBudget: { type: "number", minimum: 1000 },
            hardBudget: { type: "number", minimum: 1000 },
            maxPlanNodes: { type: "number", minimum: 1, maximum: 50 },
            maxDepth: { type: "number", minimum: 1, maximum: 20 },
          },
        },
        discovery: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string" },
            thinking: { type: "boolean" },
            effort: { type: "string" },
            missRateRetryThreshold: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
          },
        },
        identification: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string" },
            thinking: { type: "boolean" },
            effort: { type: "string" },
            missRateRetryThreshold: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
          },
        },
        extraction: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string" },
            thinking: { type: "boolean" },
            effort: { type: "string" },
            missRateRetryThreshold: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            maxFocusCategories: { type: "number", minimum: 1, maximum: 10 },
            maxQuotesCeiling: { type: "number", minimum: 1, maximum: 50 },
            maxQuotesPerProduct: { type: "number", minimum: 1 },
            minIngestionRelevance: {
              type: "number",
              minimum: 0,
              maximum: 100,
            },
          },
        },
        labeling: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string" },
            thinking: { type: "boolean" },
            effort: { type: "string" },
            maxNodes: { type: "number", minimum: 1, maximum: 50 },
            strictSchema: { type: "boolean" },
          },
        },
        validation: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string" },
            thinking: { type: "boolean" },
            effort: { type: "string" },
            softBudget: { type: "number", minimum: 1000 },
            hardBudget: { type: "number", minimum: 1000 },
            maxNodes: { type: "number", minimum: 1, maximum: 50 },
            maxDepth: { type: "number", minimum: 1, maximum: 20 },
          },
        },
        opSummarizer: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string" },
            thinking: { type: "boolean" },
            effort: { type: "string" },
            threshold: { type: "number", minimum: 0 },
          },
        },
        imageAnalysis: {
          type: "object",
          additionalProperties: false,
          properties: {
            model: { type: "string" },
          },
        },
        cheatSheet: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxProducts: { type: "number", minimum: 1, maximum: 50 },
            maxOpSlots: { type: "number", minimum: 1, maximum: 20 },
            maxChars: { type: "number", minimum: 500 },
            minSlotsPerCategory: { type: "number", minimum: 1, maximum: 10 },
            lowRefThreshold: { type: "number", minimum: 1 },
          },
        },
      },
    },
    debug: {
      type: "object",
      description: "Debug trace configuration.",
      properties: {
        traceEnabled: {
          type: "boolean",
          description:
            "Enable recording of processing traces for debugging. Default: false",
          default: false,
        },
      },
    },
    webSearch: {
      type: "object",
      description: "Web search configuration for product resolution.",
      properties: {
        defaultProvider: {
          type: ["string", "null"],
          enum: ["dataforseo", "exa", null],
          description:
            "Default web search provider (null = use providerSelection logic). Default: null",
        },
        providerSelection: {
          type: "object",
          description: "Provider selection strategy for hybrid mode.",
          properties: {
            useExaForOp: {
              type: "boolean",
              description:
                "Use Exa.ai for OP (original post) comments. Default: true",
              default: true,
            },
            minRelevanceForExa: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description:
                "Minimum relevance score to use Exa (0-1). Default: 0.8",
              default: 0.8,
            },
          },
        },
        cache: {
          type: "object",
          description: "Web search result caching configuration.",
          properties: {
            enabled: {
              type: "boolean",
              description: "Enable web search result caching. Default: true",
              default: true,
            },
            similarityThreshold: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description:
                "Min keyword similarity for cache hit (0-1). Default: 0.7",
              default: 0.7,
            },
            dateToleranceDays: {
              type: "number",
              minimum: 0,
              maximum: 90,
              description: "Date tolerance window in days (±). Default: 7",
              default: 7,
            },
            ttlDays: {
              type: "number",
              minimum: 1,
              maximum: 365,
              description: "Cache entry TTL in days. Default: 90",
              default: 90,
            },
          },
        },
        dataforseo: {
          type: "object",
          description: "DataForSEO provider configuration.",
          properties: {
            maxResults: {
              type: "number",
              minimum: 1,
              maximum: 50,
              description: "Number of results to fetch. Default: 15",
              default: 15,
            },
          },
        },
        exa: {
          type: "object",
          description: "Exa.ai provider configuration.",
          properties: {
            numResults: {
              type: "number",
              minimum: 1,
              maximum: 20,
              description: "Number of results to fetch from Exa. Default: 10",
              default: 10,
            },
            useAutoprompt: {
              type: "boolean",
              description: "Let Exa optimize the search query. Default: true",
              default: true,
            },
            type: {
              type: "string",
              enum: ["neural", "keyword"],
              description:
                "Exa search type (neural for semantic). Default: neural",
              default: "neural",
            },
            includeContent: {
              type: "boolean",
              description:
                "Include full page content in results. Default: true",
              default: true,
            },
          },
        },
      },
    },
    resolution: {
      type: "object",
      additionalProperties: true,
      description: "Product resolution thresholds and matching weights.",
      properties: {
        embeddingSimilarityThreshold: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Minimum cosine similarity for embedding search candidates. Default: 0.6",
          default: 0.6,
        },
        embeddingResultLimit: {
          type: "number",
          minimum: 1,
          maximum: 50,
          description:
            "Max candidates returned from embedding search. Default: 5",
          default: 5,
        },
        webSearchRelevanceGate: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            "Minimum reference relevance to trigger a web search during product resolution. Default: 70",
          default: 70,
        },
        search: {
          type: "object",
          additionalProperties: true,
          description: "ProductSearchAgent configuration.",
          properties: {
            maxModelVariants: {
              type: "number",
              minimum: 1,
              maximum: 100,
              description:
                "Maximum entries in context.modelVariants across all iterations. Default: 20",
              default: 20,
            },
            maxCandidates: {
              type: "number",
              minimum: 1,
              maximum: 500,
              description:
                "Maximum candidate pool size after each merge. Default: 50",
              default: 50,
            },
            acceptThreshold: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description:
                "Conservative acceptance threshold (0–1) for final resolution. Picks below this score are downgraded to unresolved. Default: 0.5",
              default: 0.5,
            },
          },
        },
      },
    },
    rating: {
      type: "object",
      description: "Product rating configuration.",
      properties: {
        priorWeight: {
          type: "number",
          minimum: 0,
          description:
            "Bayesian prior weight — pulls low-N ratings toward 50. Default: 3",
          default: 3,
        },
        useCasePriorWeight: {
          type: "number",
          minimum: 0,
          description:
            "Bayesian prior weight for per-use-case scores. Lighter than priorWeight because use-case n is inherently small. Default: 1.5",
          default: 1.5,
        },
        minHighlightScore: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            "Minimum score (0–100) for a feature highlight to surface. Default: 20",
          default: 20,
        },
        minHighlightMentions: {
          type: "number",
          minimum: 1,
          description:
            "Minimum mention count for a feature highlight in the API response. Default: 2",
          default: 2,
        },
        minReviewScore: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            "Minimum reviewScore for a review to be visible and contribute to product rating. Default: 20",
          default: 20,
        },
      },
    },
    review: {
      type: "object",
      description: "Review creation configuration.",
      properties: {
        topQuoteLimit: {
          type: "number",
          minimum: 1,
          description:
            "Max quotes persisted on review.quotes after scoring/sort/cap. Default: 8",
          default: 8,
        },
      },
    },
    reprocessing: {
      type: "object",
      description:
        "Configuration for re-processing previously EXTRACTED threads.",
      properties: {
        enabled: {
          type: "boolean",
          description:
            "Enable re-processing of EXTRACTED threads. Default: false",
          default: false,
        },
        reprocessAfterDays: {
          type: "number",
          minimum: 1,
          description:
            "Re-process threads last processed more than this many days ago. Default: 30",
          default: 30,
        },
        dailyBudgetFraction: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Fraction of threadProcessingPerDay budget reserved for reprocessing. Default: 0.2",
          default: 0.2,
        },
        maxReprocessPerCycle: {
          type: "number",
          minimum: 1,
          description:
            "Max threads to reprocess per scheduler cycle. Default: 3",
          default: 3,
        },
      },
    },
    preprocessing: {
      type: "object",
      description: "Preprocessing configuration for thread ingestion.",
      properties: {
        minScore: {
          type: "number",
          minimum: 0,
          description:
            "Minimum Reddit upvote score for a submission to be ingested. Default: 15",
          default: 15,
        },
        minComments: {
          type: "number",
          minimum: 0,
          description:
            "Minimum comment count for a submission to be ingested. Default: 8",
          default: 8,
        },
        minRelevanceForIngestion: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            "Minimum relevance score for a thread to be kept after preprocessing. Threads below this are deleted. Default: 40",
          default: 40,
        },
      },
    },
    translation: {
      type: "object",
      description: "LLM-backed translation service configuration.",
      additionalProperties: true,
      properties: {
        enabled: { type: "boolean", default: true },
        model: { type: "string", default: "deepseek-v4-flash" },
        defaultSourceLanguage: { type: "string", default: "hu" },
        defaultTargetLanguage: { type: "string", default: "en" },
        cacheTtlDays: { type: "number", minimum: 1, default: 365 },
        maxBatchSize: { type: "number", minimum: 1, maximum: 500, default: 50 },
        dictionary: { type: "object" },
      },
    },
    adminContactEmail: {
      type: "string",
      description: "Email address for contact form and feedback notifications.",
    },
    amazonAffiliateTag: {
      type: "string",
      description:
        'Amazon Associates tag appended to Amazon shop links (e.g. "ebike-20").',
    },
  },
  required: [
    "redditSearchThreadLimit",
    "redditThreadExpiryInDays",
    "threadProcessingPerDay",
  ],
};
