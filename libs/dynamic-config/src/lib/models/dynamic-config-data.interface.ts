export interface GeneralConfig {
  adminContactEmail?: string;
  amazonAffiliateTag?: string;
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

  /**
   * Offer freshness — the whole delisting mechanism. Read from `offers.json`.
   *
   * An import run stamps Offer.lastSynced; nothing else marks an offer gone.
   * So a source that stops seeing a product simply stops stamping it: the
   * offer becomes inactive (hidden, and no longer sets its product's price —
   * the nightly sweep reprices the product), and is later deleted. There are no
   * miss counters and no separate gone-sweep.
   *
   * deleteAfterDays must stay comfortably larger than freshnessDays: the gap is
   * the grace period in which a source can be broken, paused or mid-backfill
   * without its catalog being destroyed.
   */
  offers?: {
    /**
     * Offers not synced for this many days are inactive: hidden, and no longer
     * set their product's price. Default: 3
     */
    freshnessDays?: number;
    /** Offers not synced for this many days are hard-deleted. Default: 14 */
    deleteAfterDays?: number;
    /**
     * Whether the sweep actually deletes. Default: FALSE; `offers.json` turns it on.
     *
     * The sweep's premise is that imports are running: an offer is only "gone"
     * because a run that DID happen stopped confirming it. So it keeps the
     * offers of any seller none of whose offers was confirmed within
     * freshnessDays — a broken or paused source, or an environment that is not
     * importing — and this switch stays as the kill switch on top of that.
     *
     * With this off the sweep still runs and logs exactly what it WOULD delete.
     */
    deletionEnabled?: boolean;
    /**
     * Whether a complete run of a source that lists the shop's whole catalog
     * (ProductSource.hasAllProducts) removes the seller's offers it did not
     * see. Default: TRUE. The kill switch for that removal: it acts at once,
     * not after deleteAfterDays, and while off the offers age out as usual.
     */
    completeSourceRemovalEnabled?: boolean;
  };

  /** Import behaviour shared across every scraping source. Read from `import.json`. */
  import?: {
    /**
     * Which ScrapedListProduct fields a list card must carry before an
     * ALREADY-KNOWN listing can be refreshed from it without opening its
     * detail page.
     *
     * This is the cost control: every item that satisfies the set is a paid
     * detail fetch not spent. It is global config rather than a constant
     * because the trade-off is a judgement call that differs per shop and is
     * worth being able to make without a deploy — e.g. ebikeshop's cards carry
     * prices but no stock, so with `availability` in the set every one of its
     * items falls through to a detail scrape and the saving is zero; dropping
     * it buys 1334 fetches → 42 at the cost of availability going stale
     * between full detail passes.
     *
     * Unknown listings always get a detail scrape regardless — specs, brand and
     * model only exist there.
     *
     * Default: ['url', 'price', 'availability']
     */
    listRefreshRequiredFields?: string[];
  };

  // Scheduling configuration

  scheduling?: {
    /** Minutes before a PROCESSING task is considered stale and eligible for re-pickup. Default: 240 (4 hours) */
    staleTaskTimeoutMinutes?: number;
    /** Minutes before a PROCESSING import task is considered stale and eligible for re-pickup. Default: 240 (4 hours) */
    staleImportTaskTimeoutMinutes?: number;
    /**
     * How often the collector claims a batch of import tasks, in ms. Each tick
     * is one claim query, so a longer tick means fewer queries. Default: 30000.
     */
    importTaskTickMs?: number;
    /**
     * Most import tasks one tick claims and starts, however many earlier ones
     * are still running. Throughput is about batchSize x (3600000 / tickMs)
     * tasks an hour. Default: 4.
     */
    importTaskBatchSize?: number;
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
    offers: {
      type: 'object',
      description:
        'Offer freshness. Offer.lastSynced is stamped by every import run and is the only delisting signal — an offer that stops being stamped goes inactive (its product is repriced nightly), then is deleted.',
      properties: {
        freshnessDays: {
          type: 'number',
          minimum: 1,
          maximum: 365,
          description:
            'Offers not synced for this many days are inactive: hidden, and no longer set their product\'s price. Default: 3',
          default: 3,
        },
        deleteAfterDays: {
          type: 'number',
          minimum: 1,
          maximum: 365,
          description:
            'Offers not synced for this many days are hard-deleted. Must be greater than freshnessDays — the gap is the grace period for a broken or paused source. Default: 14',
          default: 14,
        },
        deletionEnabled: {
          type: 'boolean',
          description:
            'Whether the stale-offer sweep actually deletes. The sweep keeps the offers of any seller none of whose offers was confirmed within freshnessDays (a broken or paused source, or an environment that is not importing); this is the kill switch on top of that. While off it still runs and logs what it would delete. Default: false (offers.json turns it on)',
          default: false,
        },
        completeSourceRemovalEnabled: {
          type: 'boolean',
          description:
            'Whether a complete run of a source that lists the whole catalog (hasAllProducts) removes the offers it did not see, at once. The kill switch: while off, those offers age out through the stale-offer sweep as usual. Default: true',
          default: true,
        },
      },
    },
    import: {
      type: 'object',
      description:
        'Import behaviour shared across every scraping source.',
      properties: {
        listRefreshRequiredFields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'ScrapedListProduct fields a list card must carry before an already-known listing is refreshed from it instead of re-scraping its detail page. Every item that satisfies this set is a paid fetch not spent. Default: ["url","price","availability"]',
          default: ['url', 'price', 'availability'],
        },
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
