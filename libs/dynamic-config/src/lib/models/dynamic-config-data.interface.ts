export interface GeneralConfig {
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

export interface DynamicConfigData {
  /** Resolution-input enrichment configuration. */
  enrichment?: {
    /** When true, ResolutionInputEnricher runs the rule-based subject-switch
     *  classifier (see `detectSubjectSwitch`) and clears `referenceProductId` /
     *  `referenceModel` / `modelClues` / `variantClues` when the comment
     *  switches subject. Disable for emergency rollback. Default: true. */
    subjectSwitchClassifierEnabled?: boolean;
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
      /** @deprecated Detection no longer merges — every merge goes through a
       *  human accepting the row in the review queue, so there is nothing to
       *  cap. Kept so existing config files stay valid. */
      maxMergesPerRun?: number;
    };
  };

  // Product resolution thresholds and matching weights
  resolution?: {
    embeddingSimilarityThreshold?: number;
    embeddingResultLimit?: number;
    /** Minimum reference relevance to trigger a web search during product resolution */
    webSearchRelevanceGate?: number;
    /** Minimum decision score (0-100) a resolution OR duplicate-detection
     *  decision must clear before a `ProductResolution` row is persisted at
     *  all — shared by both flows via `ProductResolutionRecorderService`.
     *  Orthogonal to `matching.acceptThreshold`/`scheduling.duplicateDetection`
     *  thresholds, which decide the underlying business outcome; this only
     *  decides whether an already-made decision gets logged. Default: 60 */
    minScoreToRecord?: number;
    /** Retention for the `ProductResolution` review queue. */
    review?: {
      /** Master switch for the retention cleanup job. Default: true */
      cleanupEnabled?: boolean;
      /** Days to keep rows replaced by a newer row for the same situation.
       *  Pure noise once superseded. Default: 60 */
      supersededRetentionDays?: number;
      /** Days to keep decided rows, aged by `lastSeenAt` rather than when they
       *  were decided — a decided row is what stops the same question being
       *  asked again, so one whose listing is still being scraped is never
       *  pruned. Default: 60 */
      doneRetentionDays?: number;
      /** How far below `matching.acceptThreshold` still counts as a near miss
       *  for the `near_miss_rejection` review trigger. Best-vs-threshold, as
       *  opposed to `matching.ambiguityGap`'s best-vs-second. Default: 10 */
      nearMissBand?: number;
      /** Upper bound on `specSimilarity` (0–1) for a match to count as resting
       *  on the name alone — `name_only_match`. Not zero, because a single
       *  incidentally-shared spec should not read as corroboration.
       *  Default: 0.05 */
      nameOnlySpecSimilarityMax?: number;
      /** Days to keep undecided rows, aged by `lastSeenAt`. Far longer than the
       *  decided retention because deleting an open row is deciding it by
       *  neglect; this exists only so rows nobody will ever judge do not
       *  accumulate forever. `failed` rows are never pruned. Default: 120 */
      pendingRetentionDays?: number;
    };
    /** Settling rows without a human. */
    automation?: {
      /** Master switch over every automated path. Default: true */
      enabled?: boolean;
      /** The score-only rule: accept rows whose confidence is high enough and
       *  where no review trigger fired. Bookkeeping only — restricted to the
       *  `product_resolution` flow, where accepting confirms an action the
       *  pipeline already performed and changes nothing in the catalog. */
      deterministic?: {
        enabled?: boolean;
        /** Apply the rule during scraping, so a trusted row is settled before it
         *  ever reaches the queue. Off leaves only the nightly catch-up.
         *  Default: true */
        atRecordTime?: boolean;
        /** Log what would be accepted without writing anything — turn it on to
         *  read a night's worth of would-accepts against real traffic before
         *  letting it close rows for real. Default: false */
        dryRun?: boolean;
        /** `decisionConfidence` a row must reach. A starting guess to measure,
         *  not a constant to trust — see the dryRun output. Default: 90 */
        minConfidence?: number;
        /** Upper bound on rows the nightly catch-up settles in one run.
         *  Default: 200 */
        maxPerRunNightly?: number;
      };
      /** The LLM reviewer: reads the gathered evidence plus live catalog data
       *  and judges whether the pipeline's conclusion holds up. Unlike the
       *  deterministic rule it may act destructively, behind its own switch. */
      ai?: {
        enabled?: boolean;
        /** Record the verdict on the row but act on nothing. Withholds the
         *  catalog action only: the stored verdict and its decision-log entry
         *  are written either way. Default: false */
        dryRun?: boolean;
        /** Prefix-routed to a provider — `gpt-`/`o1-`/`o3-` → openai,
         *  `claude-` → claude, `gemini-` → gemini, `deepseek-` → deepseek.
         *  Default: 'gpt-5.6-luna' */
        model?: string;
        /** Provider-native reasoning effort. Default: 'medium' */
        effort?: string;
        /** Carry out a high-confidence recommendation at all. Off makes every
         *  verdict advisory. Default: true */
        executeActions?: boolean;
        /** Allow merges and splits specifically. Separate from `executeActions`
         *  because confirming a resolution is bookkeeping while merging deletes
         *  a product — the AI can be trusted with the first before the second.
         *  Ships **off**. Default: false */
        executeDestructive?: boolean;
        /** Rows reviewed per nightly run. Default: 100 */
        maxPerRun?: number;
        /** Priority floor for intake — don't spend tokens on a drained queue.
         *  Default: 10 */
        minPriority?: number;
        /** Hard spend stop per run, via the running cost total. Default: 2 */
        maxCostUsdPerRun?: number;
        /** Re-review a row this many days after the last verdict even when
         *  nothing about it changed. Default: 30 */
        reReviewAfterDays?: number;
      };
    };
    /** The review-queue priority score: how important it is that a human looks
     *  at a row. */
    priority?: {
      /** Master switch for the nightly confidence/priority recompute sweep.
       *  Default: true */
      recomputeEnabled?: boolean;
      /** Rows loaded and rescored per batch. Default: 500 */
      recomputeBatchSize?: number;
      /** Upper bound on rows rescored in one nightly run, so a very large
       *  queue degrades to "takes a few nights" rather than "runs until
       *  morning". Default: 50000 */
      maxRowsPerRun?: number;
      /**
       * Scoring weights, overridable so tuning needs no deploy.
       *
       * These are informed guesses until there is enough review history to fit
       * them against (see §4.1 of `docs/ResolutionConfidenceScoreAnalysis.md`),
       * which is exactly why they are the one part of the calculation that can
       * be changed at runtime. Anything omitted keeps its coded default.
       */
      weights?: {
        /** How much each piece of evidence counts toward `decisionConfidence`. */
        confidence?: {
          outcomeAgreement?: number;
          specAgreement?: number;
          gateAgreement?: number;
          corroboration?: number;
          margin?: number;
          selfReport?: number;
        };
        /** How much each factor counts toward what a wrong decision costs. */
        impact?: {
          blastRadius?: number;
          actionKind?: number;
          mergeReach?: number;
        };
      };
    };
    matching?: {
      acceptThreshold?: number;
      acceptThresholdStrict?: number;
      ambiguityGap?: number;
      defaultStrictness?: 'strict' | 'moderate' | 'loose';
      defaultNumericTokenWeight?: number;
      /** Used by product-normalizer for token importance filtering */
      importantTokenWeightThreshold?: number;
      /** Hard cap on how many picks the decision LLM may return. Bounds prompt
       *  cost and downstream candidate fan-out. Default: 6 */
      maxLlmPicks?: number;
      /** Minimum matcher score (0–100) a rejected candidate set's best
       *  candidate must still clear before the scrape-time LLM merge decision
       *  is worth invoking — below this, the candidate is simply wrong, not
       *  "close but ambiguous," and asking an LLM to adjudicate wastes a call
       *  and adds false-merge risk. Default: 50 */
      llmDecisionFloor?: number;
    };
    // ProductSearchAgent configuration
    search?: ProductSearchAgentConfig;
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
    defaultProvider?: 'dataforseo' | 'exa';

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
      type?: 'neural' | 'keyword';
      /** Include full page content in results */
      includeContent?: boolean;
    };
  };

  // Contact form + feedback notifications
  adminContactEmail?: string;

  // Amazon Associates tag (e.g. "fittkereso-20")
  amazonAffiliateTag?: string;
}

export const dynamicConfigSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    debug: {
      type: 'object',
      description: 'Debug trace configuration.',
      properties: {
        traceEnabled: {
          type: 'boolean',
          description:
            'Enable recording of processing traces for debugging. Default: false',
          default: false,
        },
      },
    },
    webSearch: {
      type: 'object',
      description: 'Web search configuration for product resolution.',
      properties: {
        defaultProvider: {
          type: ['string', 'null'],
          enum: ['dataforseo', 'exa', null],
          description:
            'Default web search provider (null = use providerSelection logic). Default: null',
        },
        providerSelection: {
          type: 'object',
          description: 'Provider selection strategy for hybrid mode.',
          properties: {
            useExaForOp: {
              type: 'boolean',
              description:
                'Use Exa.ai for OP (original post) comments. Default: true',
              default: true,
            },
            minRelevanceForExa: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description:
                'Minimum relevance score to use Exa (0-1). Default: 0.8',
              default: 0.8,
            },
          },
        },
        cache: {
          type: 'object',
          description: 'Web search result caching configuration.',
          properties: {
            enabled: {
              type: 'boolean',
              description: 'Enable web search result caching. Default: true',
              default: true,
            },
            similarityThreshold: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description:
                'Min keyword similarity for cache hit (0-1). Default: 0.7',
              default: 0.7,
            },
            dateToleranceDays: {
              type: 'number',
              minimum: 0,
              maximum: 90,
              description: 'Date tolerance window in days (±). Default: 7',
              default: 7,
            },
            ttlDays: {
              type: 'number',
              minimum: 1,
              maximum: 365,
              description: 'Cache entry TTL in days. Default: 90',
              default: 90,
            },
          },
        },
        dataforseo: {
          type: 'object',
          description: 'DataForSEO provider configuration.',
          properties: {
            maxResults: {
              type: 'number',
              minimum: 1,
              maximum: 50,
              description: 'Number of results to fetch. Default: 15',
              default: 15,
            },
          },
        },
        exa: {
          type: 'object',
          description: 'Exa.ai provider configuration.',
          properties: {
            numResults: {
              type: 'number',
              minimum: 1,
              maximum: 20,
              description: 'Number of results to fetch from Exa. Default: 10',
              default: 10,
            },
            useAutoprompt: {
              type: 'boolean',
              description: 'Let Exa optimize the search query. Default: true',
              default: true,
            },
            type: {
              type: 'string',
              enum: ['neural', 'keyword'],
              description:
                'Exa search type (neural for semantic). Default: neural',
              default: 'neural',
            },
            includeContent: {
              type: 'boolean',
              description:
                'Include full page content in results. Default: true',
              default: true,
            },
          },
        },
      },
    },
    resolution: {
      type: 'object',
      additionalProperties: true,
      description: 'Product resolution thresholds and matching weights.',
      properties: {
        embeddingSimilarityThreshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'Minimum cosine similarity for embedding search candidates. Default: 0.6',
          default: 0.6,
        },
        embeddingResultLimit: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          description:
            'Max candidates returned from embedding search. Default: 5',
          default: 5,
        },
        webSearchRelevanceGate: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description:
            'Minimum reference relevance to trigger a web search during product resolution. Default: 70',
          default: 70,
        },
        minScoreToRecord: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description:
            'Minimum decision score (0-100) to persist a ProductResolution row, shared by both the resolution and duplicate-detection flows. Default: 60',
          default: 60,
        },
        review: {
          type: 'object',
          additionalProperties: true,
          description: 'Retention for the ProductResolution review queue.',
          properties: {
            cleanupEnabled: {
              type: 'boolean',
              description:
                'Master switch for the review-queue retention cleanup job. Default: true',
              default: true,
            },
            supersededRetentionDays: {
              type: 'number',
              minimum: 1,
              description:
                'Days to keep resolution rows that were superseded by a newer row for the same situation. Default: 60',
              default: 60,
            },
            doneRetentionDays: {
              type: 'number',
              minimum: 1,
              description:
                'Days to keep decided resolution rows, aged by lastSeenAt so rows for still-scraped listings are never pruned. Default: 60',
              default: 60,
            },
            nearMissBand: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              description:
                'How far below matching.acceptThreshold still counts as a near miss for the near_miss_rejection review trigger. Default: 10',
              default: 10,
            },
            nameOnlySpecSimilarityMax: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description:
                'Upper bound on specSimilarity (0-1) for a match to count as resting on the name alone — the name_only_match review trigger. Default: 0.05',
              default: 0.05,
            },
            pendingRetentionDays: {
              type: 'number',
              minimum: 1,
              description:
                'Days to keep undecided rows, aged by lastSeenAt. Failed rows are never pruned. Default: 120',
              default: 120,
            },
          },
        },
        automation: {
          type: 'object',
          additionalProperties: true,
          description: 'Settling review-queue rows without a human.',
          properties: {
            enabled: {
              type: 'boolean',
              description:
                'Master switch over every automated review path. Default: true',
              default: true,
            },
            deterministic: {
              type: 'object',
              additionalProperties: true,
              description:
                'The score-only auto-accept rule. Bookkeeping only — restricted to the product_resolution flow, where accepting confirms an action already performed and changes nothing in the catalog.',
              properties: {
                enabled: {
                  type: 'boolean',
                  description:
                    'Master switch for deterministic auto-accept. Default: true',
                  default: true,
                },
                atRecordTime: {
                  type: 'boolean',
                  description:
                    'Apply the rule during scraping so a trusted row never enters the queue. Off leaves only the nightly catch-up. Default: true',
                  default: true,
                },
                dryRun: {
                  type: 'boolean',
                  description:
                    'Log what would be accepted without writing anything. Default: false',
                  default: false,
                },
                minConfidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 100,
                  description:
                    'decisionConfidence a row must reach to be auto-accepted. Default: 90',
                  default: 90,
                },
                maxPerRunNightly: {
                  type: 'number',
                  minimum: 0,
                  description:
                    'Upper bound on rows the nightly catch-up settles in one run. Default: 200',
                  default: 200,
                },
              },
            },
            ai: {
              type: 'object',
              additionalProperties: true,
              description:
                'The LLM reviewer. Reads the gathered evidence plus live catalog data and judges whether the pipeline was right. May act destructively, behind its own switch.',
              properties: {
                enabled: {
                  type: 'boolean',
                  description: 'Master switch for AI review. Default: true',
                  default: true,
                },
                dryRun: {
                  type: 'boolean',
                  description:
                    'Record the verdict on the row but act on nothing. The verdict and its decision-log entry are still written. Default: false',
                  default: false,
                },
                model: {
                  type: 'string',
                  description:
                    'Prefix-routed to a provider (gpt-/o1-/o3- → openai, claude- → claude, gemini- → gemini, deepseek- → deepseek). Default: gpt-5.6-luna',
                  default: 'gpt-5.6-luna',
                },
                effort: {
                  type: 'string',
                  description:
                    'Provider-native reasoning effort. Default: medium',
                  default: 'medium',
                },
                executeActions: {
                  type: 'boolean',
                  description:
                    'Carry out a high-confidence recommendation at all. Off makes every verdict advisory. Default: true',
                  default: true,
                },
                executeDestructive: {
                  type: 'boolean',
                  description:
                    'Allow merges and splits specifically. Ships off — confirming a resolution is bookkeeping, merging deletes a product. Default: false',
                  default: false,
                },
                maxPerRun: {
                  type: 'number',
                  minimum: 0,
                  description: 'Rows reviewed per nightly run. Default: 100',
                  default: 100,
                },
                minPriority: {
                  type: 'number',
                  minimum: 0,
                  maximum: 100,
                  description:
                    'Priority floor for intake, so a drained queue costs nothing. Default: 10',
                  default: 10,
                },
                maxCostUsdPerRun: {
                  type: 'number',
                  minimum: 0,
                  description: 'Hard spend stop per run. Default: 2',
                  default: 2,
                },
                reReviewAfterDays: {
                  type: 'number',
                  minimum: 1,
                  description:
                    'Re-review a row this many days after the last verdict even when nothing changed. Default: 30',
                  default: 30,
                },
              },
            },
          },
        },
        priority: {
          type: 'object',
          additionalProperties: true,
          description:
            'The review-queue priority score — how important it is that a human looks at a row.',
          properties: {
            recomputeEnabled: {
              type: 'boolean',
              description:
                'Master switch for the nightly confidence/priority recompute sweep. Default: true',
              default: true,
            },
            recomputeBatchSize: {
              type: 'number',
              minimum: 1,
              maximum: 5000,
              description: 'Rows loaded and rescored per batch. Default: 500',
              default: 500,
            },
            maxRowsPerRun: {
              type: 'number',
              minimum: 1,
              description:
                'Upper bound on rows rescored in one nightly run. Default: 50000',
              default: 50000,
            },
            weights: {
              type: 'object',
              additionalProperties: true,
              description:
                'Scoring weights, overridable so tuning needs no deploy. Anything omitted keeps its coded default.',
              properties: {
                confidence: {
                  type: 'object',
                  additionalProperties: true,
                  description:
                    'How much each piece of evidence counts toward decisionConfidence.',
                },
                impact: {
                  type: 'object',
                  additionalProperties: true,
                  description:
                    'How much each factor counts toward what a wrong decision costs.',
                },
              },
            },
          },
        },
        search: {
          type: 'object',
          additionalProperties: true,
          description: 'ProductSearchAgent configuration.',
          properties: {
            maxModelVariants: {
              type: 'number',
              minimum: 1,
              maximum: 100,
              description:
                'Maximum entries in context.modelVariants across all iterations. Default: 20',
              default: 20,
            },
            maxCandidates: {
              type: 'number',
              minimum: 1,
              maximum: 500,
              description:
                'Maximum candidate pool size after each merge. Default: 50',
              default: 50,
            },
            acceptThreshold: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description:
                'Conservative acceptance threshold (0–1) for final resolution. Picks below this score are downgraded to unresolved. Default: 0.5',
              default: 0.5,
            },
          },
        },
      },
    },
    translation: {
      type: 'object',
      description: 'LLM-backed translation service configuration.',
      additionalProperties: true,
      properties: {
        enabled: { type: 'boolean', default: true },
        model: { type: 'string', default: 'deepseek-v4-flash' },
        defaultSourceLanguage: { type: 'string', default: 'hu' },
        defaultTargetLanguage: { type: 'string', default: 'en' },
        cacheTtlDays: { type: 'number', minimum: 1, default: 365 },
        maxBatchSize: { type: 'number', minimum: 1, maximum: 500, default: 50 },
        dictionary: { type: 'object' },
      },
    },
    adminContactEmail: {
      type: 'string',
      description: 'Email address for contact form and feedback notifications.',
    },
    amazonAffiliateTag: {
      type: 'string',
      description:
        'Amazon Associates tag appended to Amazon shop links (e.g. "fittkereso-20").',
    },
  },
  required: [],
};
