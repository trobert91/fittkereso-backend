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

  // Scheduling configuration

  scheduling?: {
    /** Minutes before a PROCESSING task is considered stale and eligible for re-pickup. Default: 240 (4 hours) */
    staleTaskTimeoutMinutes?: number;
    /** Minutes before a PROCESSING scrape task is considered stale and eligible for re-pickup. Default: 240 (4 hours) */
    staleScrapeTaskTimeoutMinutes?: number;
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
