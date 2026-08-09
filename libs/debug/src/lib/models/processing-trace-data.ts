export interface BaseTraceData {
  summary: string;
  decision?: {
    action: string;
    reason: string;
  };
  error?: {
    message: string;
    stack?: string;
  };
}

export interface LlmTraceData extends BaseTraceData {
  llm: {
    /** Raw system prompt — transformed to hash by DebugTraceService before storage. */
    systemPrompt?: string;
    /** Hash stored after transformation. Present on read, absent on write. */
    systemPromptHash?: string;
    userPrompt: string;
    rawResponse: string;
    parsedResponse?: any;
    validationResult?: {
      filtered?: string[];
      hallucinatedSpansRemoved?: number;
      deduplicationCount?: number;
    };
    temperature: number;
    schema?: string;
    complexity?: number;
    cachedTokens?: number;
    retryCount?: number;
  };
}

export interface RelevanceTraceData extends BaseTraceData {
  relevance: {
    score: number;
    threshold: number;
    passed: boolean;
    components?: {
      fuzzyScore: number;
      diversity: number;
      reviewIntentMultiplier: number;
      penaltyMultiplier: number;
      deliberationMultiplier: number;
      depthMultiplier: number;
      questionPenalty: number;
      disclaimerPenalty: number;
      socialPenalty: number;
      ownershipMultiplier: number;
      comparisonMultiplier: number;
      brandBoost: number;
      productTermContribution: number;
      topTerms: Array<{
        keyword: string;
        score: number;
        maxScore: number;
      }>;
    };
    refs?: Array<{
      refId: string;
      score: number;
      factors: {
        depthMultiplier: number;
        quoteQualityMultiplier: number;
        sentimentMultiplier: number;
        experienceMultiplier: number;
        experienceFloorBonus: number;
        featureMultiplier: number;
        useCaseMultiplier: number;
        intentMultiplier?: number;
      };
      inputs: {
        depth: string;
        sentiment: string;
        experience: string;
        intents: string[];
        quoteCount: number;
        validQuoteCount: number;
        featureCount: number;
        useCaseCount: number;
      };
      contentScore: number;
      enabled: boolean;
    }>;
  };
}

export interface PlanningTraceData extends LlmTraceData {
  planning: {
    inputContext: {
      commentBody: string;
      parentCommentBody?: string;
      parentProducts: Array<{
        displayName: string;
        priority: number;
      }>;
      topic: string;
    };
    modelSelection: {
      model: string;
      complexity: number;
      rationale?: string;
    };
    rawMentions: number;
    validatedMentions: number;
    hallucinatedSpansRemoved: number;
  };
}

export interface ExtractionTraceData extends LlmTraceData {
  extraction: {
    inputMentions: Array<{
      brand?: string;
      model?: string;
      displayName: string;
    }>;
    extractedProducts: Array<{
      displayName: string;
      quotes: string[];
      sentiment?: string;
    }>;
    referencesCreated: Array<{
      id: string;
      relevance: number;
      enabled: boolean;
    }>;
  };
}

export interface ResolutionTraceData extends BaseTraceData {
  resolution: {
    referenceId: string;
    input: {
      displayName: string;
      brand?: string;
      model?: string;
      referenceProductId?: string | null;
      referenceModel?: string | null;
      modelClues?: string[] | null;
      variantClues?: string[] | null;
    };
    refinedInput?: {
      brand?: string;
      model?: string;
      category?: string;
    };
    brandCandidates?: Array<{
      id: string;
      name: string;
      score: number;
    }>;
    categoryCandidates?: Array<{
      id: string;
      name: string;
      score: number;
    }>;
    productCandidates: Array<{
      id: string;
      name?: string;
      brand?: string;
      distance?: number;
      score?: number;
      confidence?: number;
      source?: string;
    }>;
    webSearch?: {
      used: boolean;
      query?: string;
      provider?: 'dataforseo' | 'exa';
      source?: 'cache' | 'api';
      cacheHit?: boolean;
      cacheEntryId?: string;
      similarity?: number;
      cacheDateDiff?: number;
      skippedByEvaluator?: boolean;
      evaluatorConfidence?: number;
      results?: Array<{
        title: string;
        url: string;
        snippet: string;
      }>;
    };
    resolvedProduct?: {
      id: string;
      name?: string;
      displayName?: string;
      brand?: string;
      model?: string;
    };
    registryHit?: boolean;
    registryBypassReason?: string;
    phaseTimings?: Record<string, number>;
    // ── v2 fields (libs/product-search) ─────────────────────────────────────
    /** Resolved brand entity from the search context. */
    brand?: { id: string; name: string; similarity: number };
    /** Resolved category from the search context. */
    category?: { id: string; name: string; similarity: number };
    /** Reference product when one was set + classified by ReferenceProductResolver. */
    referenceProduct?: { productId: string; brand?: string; model?: string };
    /** Final decision the new lib reached (kind, reason, confidence on 0–100). */
    decision?: {
      kind: string;
      reason: string;
      confidence: number;
      selectedCandidates?: Array<{
        candidateId: string;
        confidence: number;
        reason?: string;
      }>;
      evidenceSummary?: string;
    };
    /** Scoring snapshot (best/runner-up, failed gates, normalized input). */
    scoring?: unknown;
    /** Filter outcome — surviving + dropped candidate ids with reasons. */
    filter?: unknown;
    /** Recall funnel counts per source. */
    recallFunnel?: unknown;
    /** Which recall strategies actually ran (e.g. `['fuzzy', 'web']`). */
    strategiesRun?: string[];
    /** Web-research metadata: queries fired, extracted SKUs, web-only models. */
    webResearch?: unknown;
    /** Phase errors recorded during the run. */
    errors?: unknown[];
  };
}

export interface ModerationTraceData extends LlmTraceData {
  moderation: {
    inputContext: {
      commentBody: string;
      parentContext?: string;
      referenceSummaries: string[];
    };
    moderatorOutput: {
      status: string;
      flags: string[];
      necessaryFixes?: string[];
    };
    overrideDecisions?: Array<{
      type: string;
      applied: boolean;
      reason: string;
    }>;
  };
}

export interface ConfigSnapshotTraceData extends BaseTraceData {
  configSnapshot: {
    processor?: Record<string, any>;
    pipeline?: Record<string, any>;
    debug?: { traceEnabled: boolean };
    identificationBuilder?: Record<string, any>;
    analysisBuilder?: Record<string, any>;
    discovery?: Record<string, any>;
    identification?: Record<string, any>;
    extraction?: Record<string, any>;
    labeling?: Record<string, any>;
    validation?: Record<string, any>;
    opSummarizer?: Record<string, any>;
    imageAnalysis?: Record<string, any>;
    registryOpts?: Record<string, any>;
  };
}

// ── Batched Pipeline Trace Data Types ─────────────────────────────────────────

export interface BatchInitTraceData extends BaseTraceData {
  batchInit: {
    processedComments: number;
    newComments: number;
    orphansRecovered: number;
    productsLoaded: number;
  };
}

export interface SubtreeBuildingTraceData extends BaseTraceData {
  subtreeBuilding: {
    subtreeCount: number;
    totalPlanNodes: number;
    totalContextNodes: number;
    subtrees: Array<{
      index: number;
      planNodeCount: number;
      contextNodeCount: number;
      maxDepth: number;
      estimatedTokens: number;
      nodes: Array<{
        commentId: string;
        externalId?: string;
        author: string;
        nodeType: 'PLAN' | 'CONTEXT';
        depth: number;
        bodyPreview: string;
      }>;
    }>;
    config: {
      softBudget: number;
      hardBudget: number;
      maxPlanNodes: number;
      maxDepth: number;
    };
  };
}

export interface MediaAnalysisTraceData extends BaseTraceData {
  mediaAnalysis: {
    imageUrl: string | null;
    hasUsefulContent: boolean;
    contentLength: number;
  };
  llm?: {
    rawResponse: string;
    temperature: number;
    cachedTokens?: number;
  };
}

export interface OPSummarizationTraceData extends BaseTraceData {
  opSummarization: {
    originalLength: number;
    summaryLength: number;
    action: 'summarized' | 'skipped';
    model: string;
  };
  llm?: LlmTraceData['llm'];
}

export interface SubtreeExtractionTraceData extends BaseTraceData {
  extraction: {
    subtreeIndex: number;
    batchId: string;
    isAnchor: boolean;
    batchAnchorCommentId: string;
    planNodeCount: number;
    contextNodeCount: number;
    missRate: number;
    retried: boolean;
    cheatSheetChars: number;
    cheatSheetProducts: number;
    extractedProducts?: Array<{
      displayName: string;
      quotes: string[];
      sentiment?: string;
    }>;
    referencesCreated?: Array<{
      id: string;
      relevance: number;
      enabled: boolean;
    }>;
  };
  /** Present only on the batch anchor comment. */
  batch?: {
    planNodeCount: number;
    contextNodeCount: number;
    model: string;
    missRate: number;
    retried: boolean;
    totalCost: number;
    cheatSheetChars: number;
    cheatSheetProducts: number;
  };
  /** Present only on the batch anchor comment. */
  llm?: LlmTraceData['llm'];
}

export interface SubtreeValidationTraceData extends BaseTraceData {
  validation: {
    subtreeIndex: number;
    batchId: string | null;
    isAnchor: boolean;
    batchAnchorCommentId: string | null;
    outcome: string;
    issues?: Array<{
      refId: string;
      issue: string;
      reviewComment: string;
    }>;
    safetyNetOverride: boolean;
  };
  /** Present only on the batch anchor comment. */
  batch?: {
    model: string;
    validateNodeCount: number;
    totalCost: number;
  };
  /** Present only on the batch anchor comment. */
  llm?: LlmTraceData['llm'];
}

export interface SubtreeLabelingTraceData extends BaseTraceData {
  labeling: {
    subtreeIndex: number;
    productLabelsCount: number;
    quoteLabelsCount: number;
    lowValueCount?: number;
  };
  llm?: LlmTraceData['llm'];
}

/** @deprecated Optimizer step removed. Kept for backwards compatibility with existing traces. */
export interface OptimizerTraceData extends BaseTraceData {
  optimizer: {
    subtreeIndex: number;
    lowValueCount: number;
    removedQuoteCount: number;
  };
  llm?: LlmTraceData['llm'];
}

export interface SubtreeIdentificationTraceData extends BaseTraceData {
  identification: {
    subtreeIndex: number;
    planNodesBefore: number;
    planNodesAfter: number;
    demotedCount: number;
    demotedComments: string[];
    productMap: Record<string, string[]>;
  };
  llm?: LlmTraceData['llm'];
}

/** Pass-1 `product_discovery` LLM step (two-pass pipeline). */
export interface ProductDiscoveryTraceData extends BaseTraceData {
  discovery: {
    distinctProducts?: number;
  };
  llm?: LlmTraceData['llm'];
}

/** Pass-1 `comment_identification` LLM step (two-pass pipeline). */
export interface CommentIdentificationTraceData extends BaseTraceData {
  commentIdentification: {
    planNodes?: number;
    mappedComments?: number;
  };
  llm?: LlmTraceData['llm'];
}

export interface RegistryUpdateTraceData extends BaseTraceData {
  registryUpdate: {
    subtreeIndex: number;
    productsAdded: number;
    totalProducts: number;
    registryHits: number;
    webSearches: number;
    cheatSheetChars: number;
  };
}

export interface MatchOutcomeTraceData {
  rejected: boolean;
  rejectionReason?: string;
  matchResult?: {
    score: number;
    alias?: string;
    components?: {
      stringSimilarity: number;
      tokenOverlap: number;
      alphaMatch: number;
      aliasMatch: boolean;
      specSimilarity: number;
    };
  };
  diagnostics?: {
    normalizedInput?: string;
    inputTokens?: string[];
    failedGates?: string[];
    bestCandidate?: {
      candidateId: string;
      alias: string;
      score: number;
      components: {
        stringSimilarity: number;
        tokenOverlap: number;
        alphaMatch: number;
        aliasMatch: boolean;
        specSimilarity: number;
      };
    };
    secondScore?: number;
  };
}

export interface SubtreeResolutionTraceData extends BaseTraceData {
  resolution: {
    referenceId: string;
    input: {
      displayName?: string;
      brand?: string;
      model?: string;
      category?: string;
      referenceProductId?: string | null;
      referenceModel?: string | null;
      modelClues?: string[] | null;
      variantClues?: string[] | null;
    };
    anchorMode?: 'anchored' | 'enriched_unanchored' | 'none';
    derivedRelation?: 'same' | 'variant' | 'none';
    anchoredOutcome?: string | null;
    registryHit: boolean;
    registryBypassReason?: string;
    brand?: {
      id: string;
      name: string;
      similarity: number;
    };
    productCandidates: Array<{
      id?: string;
      name?: string;
      brand?: string;
      confidence?: number;
      source?: string;
    }>;
    resolvedProduct?: {
      id: string;
      displayName?: string;
      brand?: string;
      model?: string;
    };
    matchOutcome?: MatchOutcomeTraceData;
    contextualResolution?: {
      resolved: boolean;
      selectedCandidateId?: string;
      confidence: number;
      reason?: string;
      statusBeforeResolution?: string;
      overrodeMatcherPick?: boolean;
    };
    webSearchAttempts?: Array<{
      keyword: string;
      trigger: string;
      provider?: string;
      source?: string;
      cacheHit?: boolean;
      cacheEntryId?: string;
      serpResultCount?: number;
      discoveredVariants?: Array<{ model: string; region?: string }>;
      refinedInput?: { brand?: string; model?: string };
    }>;
    phaseTimings?: Record<string, number>;
    iterationLog?: Array<{
      iteration: number;
      agents: string[];
      statusBefore: string;
      statusAfter: string;
      durationMs: number;
    }>;
    candidateFunnel?: {
      fuzzyHits: number;
      embeddingHits: number;
      aliasHits?: number;
      modelTokenHits?: number;
      afterDedupe: number;
      afterReferenceExclusion?: number;
    };
    errors?: Array<{
      agent: string;
      message: string;
      timestamp: string;
    }>;
  };
}

export interface CategoryFocusTraceData extends BaseTraceData {
  categoryFocus: Array<{
    categoryId: string;
    categoryName: string;
    confidence: number;
    hasPromptConfig: boolean;
  }>;
}

export interface DeferredResolutionTraceData extends BaseTraceData {
  resolution: {
    referenceId: string;
    input: {
      displayName: string;
      brand?: string;
      model?: string;
      category?: string;
    };
    resolvedProduct?: {
      displayName: string;
      confidence: number | null;
    };
    matchOutcome?: MatchOutcomeTraceData;
    candidateFunnel?: {
      fuzzyHits: number;
      embeddingHits: number;
      aliasHits?: number;
      modelTokenHits?: number;
      afterDedupe: number;
      afterReferenceExclusion?: number;
    };
    webSearchAttempts?: Array<{
      keyword: string;
      trigger: string;
      provider?: string;
      source?: string;
      cacheHit?: boolean;
      cacheEntryId?: string;
      serpResultCount?: number;
      discoveredVariants?: Array<{ model: string; region?: string }>;
      refinedInput?: { brand?: string; model?: string };
    }>;
    iterationLog?: Array<{
      iteration: number;
      agents: string[];
      statusBefore: string;
      statusAfter: string;
      durationMs: number;
    }>;
    errors?: Array<{
      agent: string;
      message: string;
      timestamp: string;
    }>;
  };
}

export interface DeferredReevaluationTraceData extends BaseTraceData {
  reevaluation: {
    reason: string;
    resolvedRefsInBatch: Array<{
      referenceId: string;
      displayName?: string;
      resolvedTo?: string;
      confidence: number | null;
    }>;
    unresolvedRefsInBatch: Array<{
      referenceId: string;
      displayName?: string;
    }>;
  };
}

export interface DeferredResetTraceData extends BaseTraceData {
  reset: {
    reason: string;
    deletedRefs: Array<{
      referenceId: string;
      displayName?: string;
      category?: string;
    }>;
  };
}

export interface AdminRetryTraceData extends BaseTraceData {
  reset: {
    reason: 'admin_retry';
    reviewer: string;
    deletedRefCount: number;
  };
}

// ── Thread Selection Trace Data Types ────────────────────────────────────────

export interface ThreadSelectionTraceData extends BaseTraceData {
  threadSelection: {
    outcome: 'selected' | 'llm_low_relevance' | 'llm_no_category';
    candidateCategories: Array<{ slug: string; name: string }>;
    llmCategoryScores: Array<{ slug: string; relevance: number }>;
    acceptedCategories: Array<{ slug: string; name: string; relevance: number }>;
    criteria: {
      experienceDensity: string;
      productSpecificity: string;
      featureDiscussion: string;
      buyerResearchValue: string;
      comparativeContent: string;
    };
    /**
     * Criteria from the hard gate (experienceDensity, productSpecificity,
     * buyerResearchValue) that came back 'low'. When non-empty the outcome
     * is 'llm_low_relevance' regardless of weightedScore.
     */
    hardGateFailedCriteria: string[];
    weightedScore: number;
    breakdown: {
      llmScore: number;
      commentCountFactor: number;
      recencyFactor: number;
    };
    commentsFetched: number;
    commentSampleSize: number;
    minCategoryRelevance: number;
    minWeightedScore: number;
    model: string;
  };
}

// ── Review & Rating Trace Data Types ──────────────────────────────────────────

export interface ReviewCreationTraceData extends BaseTraceData {
  reviewCreation: {
    reviewId: string;
    productId: string;
    userId: string;
    isNew: boolean;

    sourceReferences: Array<{
      referenceId: string;
      commentId: string;
      sentiment: string;
      experience: string;
      depth: string;
      relevance: number;
      quoteCount: number;
    }>;

    sentimentAggregation: {
      finalSentiment: string;
      positiveRatio: number;
      positiveThreshold: number;
      negativeThreshold: number;
      weightedPositive: number;
      weightedTotal: number;
      perReferenceWeights: Array<{
        referenceId: string;
        experienceWeight: number;
        relevanceFactor: number;
        baseWeight: number;
        quoteCount: number;
      }>;
    };

    scoreBreakdown: {
      finalScore: number;
      depthScore: number;
      depthInput: string;
      experienceScore: number;
      experienceInput: string;
      qualityScore: number;
      partCount: number;
      communityScore: number;
      netVotes: number;
      featureCoverageBonus: number;
      prosCount: number;
      consCount: number;
      isHearsay: boolean;
      rawScore: number;
    };

    selectedExperience: string;
    selectedDepth: string;
    selectedIntents: string[];
  };
}

export interface ProductRatingTraceData extends BaseTraceData {
  productRating: {
    productId: string;
    previousRating: number | null;

    filtering: {
      totalReviews: number;
      enabledReviews: number;
      minScoreThreshold: number;
    };

    sentimentDistribution: {
      strongPositive: number;
      positive: number;
      negative: number;
      strongNegative: number;
      mixed: number;
      neutral: number;
      total: number;
      ownerCount: number;
      prospectiveBuyerCount: number;
    };

    averageReviewScore: number;

    perReviewWeights: Array<{
      reviewId: string;
      sentiment: string;
      sentimentScore: number;
      reviewScore: number;
      qualityWeight: number;
      netVotes: number;
      voteMultiplier: number;
      experience: string;
      experienceWeight: number;
      finalWeight: number;
      weightedSentiment: number;
      excluded?: boolean;
    }>;

    weightedSentimentSum: number;
    totalWeight: number;
    opinionN: number;
    excludedNeutralCount: number;
    preBayesianRating: number | null;

    bayesian: {
      priorWeight: number;
      qualityFactor: number;
      effectivePriorWeight: number;
      finalRating: number | null;
    };
  };
}

export interface FeatureHighlightsTraceData extends BaseTraceData {
  featureHighlights: {
    productId: string;
    handsonReviewCount: number;
    featureActiveUserCount: number;

    highlights: Array<{
      label: string;
      direction: 'pro' | 'con';
      score: number;
      proCount: number;
      conCount: number;
      mentionCount: number;
      proWeight: number;
      conWeight: number;
      weightedAgreement: number;
      userAgreement: number;
      coverage: number;
    }>;

    filteredOut: Array<{
      label: string;
      score: number;
    }>;
  };
}

export interface UseCaseScoringTraceData extends BaseTraceData {
  useCaseScoring: {
    productId: string;

    useCases: Array<{
      useCase: string;
      score: number | null;
      mentionCount: number;
      opinionN: number;
      excludedNeutralCount: number;
      weightedSum: number;
      totalWeight: number;
      preBayesian: number | null;
      strongPositiveCount: number;
      positiveCount: number;
      negativeCount: number;
      strongNegativeCount: number;
      mixedCount: number;
      neutralCount: number;
      averageReviewScore: number;
    }>;

    filteredOut: Array<{
      useCase: string;
      mentionCount: number;
    }>;
  };
}

export interface ThreadSearchSchedulingTraceData {
  type: 'thread-search-scheduling';

  totalSearchesPerDay: number;
  cyclesPerDay: number;
  cycleBudget: number;
  tasksCreated: number;
  budgetUtilization: number;

  eligibleCategories: number;
  selectedCategories: Array<{
    categorySlug: string;
    searchPriority: number;
    score: number;
    scoreBreakdown: {
      normalizedPriority: number;
      recencyScore: number;
      deficitScore: number;
    };
    unprocessedThreads: number;
    hoursSinceLastSearch: number | null;
    searchCount: number;
    platforms: Array<{
      platform: string;
      keywordsSelected: number;
    }>;
  }>;

  skippedCategories: Array<{
    categorySlug: string;
    score: number;
    reason: 'below_threshold' | 'zero_allocation';
  }>;
}

export interface ThreadSearchExecutionTraceData {
  type: 'thread-search-execution';

  keyword: string;
  platform: string;
  categorySlug: string;
  scope: string | null;
  mode: 'scoped' | 'broad';
  sortStrategy: string;
  searchParams: {
    time: string;
    limit: number;
  };

  totalResults: number;
  duplicates: number;
  offScope: number;
  belowQualityGate: number;
  belowRelevance: number;
  discovered: number;

  qualityGates: {
    minScore: number;
    minComments: number;
    minRelevance: number;
  };

  relevanceDistribution: {
    min: number;
    max: number;
    mean: number;
    median: number;
    p25: number;
    p75: number;
  } | null;

  sampleResults: Array<{
    externalId: string;
    title: string;
    score: number;
    commentCount: number;
    relevance: number | null;
    outcome: 'discovered' | 'duplicate' | 'off_scope' | 'below_quality_gate' | 'below_relevance';
    topic: string;
  }>;

  earlyStop: boolean;
  earlyStopChunkIndex: number | null;
  earlyStopChunkAvgRelevance: number | null;

  keywordStatsUpdate: {
    previousTotalExecutions: number;
    previousYieldRate: number | null;
    previousAverageRelevance: number | null;
    newYieldRate: number;
    newAverageRelevance: number | null;
  } | null;

  platformApiDurationMs: number;
  totalDurationMs: number;
}


export type ProcessingTraceData =
  | RelevanceTraceData
  | PlanningTraceData
  | ExtractionTraceData
  | ResolutionTraceData
  | ModerationTraceData
  | ConfigSnapshotTraceData
  | BatchInitTraceData
  | SubtreeBuildingTraceData
  | MediaAnalysisTraceData
  | OPSummarizationTraceData
  | SubtreeExtractionTraceData
  | SubtreeLabelingTraceData
  | OptimizerTraceData
  | SubtreeIdentificationTraceData
  | ProductDiscoveryTraceData
  | CommentIdentificationTraceData
  | SubtreeValidationTraceData
  | RegistryUpdateTraceData
  | SubtreeResolutionTraceData
  | CategoryFocusTraceData
  | DeferredResolutionTraceData
  | DeferredReevaluationTraceData
  | DeferredResetTraceData
  | AdminRetryTraceData
  | ThreadSelectionTraceData
  | ReviewCreationTraceData
  | ProductRatingTraceData
  | FeatureHighlightsTraceData
  | UseCaseScoringTraceData
  | ThreadSearchSchedulingTraceData
  | ThreadSearchExecutionTraceData
  | ProductSimilarityTraceData;

export interface ProductSimilarityTraceData extends BaseTraceData {
  similarity: {
    query: {
      model: string;
      displayName?: string;
      aliasCount: number;
      hasSpecs: boolean;
      year?: number;
    };
    candidate: {
      model: string;
      displayName?: string;
      aliasCount: number;
      hasSpecs: boolean;
      releaseYear?: number;
    };
    brandName?: string;
    categorySlug?: string;
    result: {
      score: number;
      nameBase: number;
      criticalNumericPenalty: number;
      suffixDiscriminatorPenalty: number;
      specPenalty: number;
      bestMatchName: string;
      components: {
        stringSimilarity: number;
        tokenOverlap: number;
        alphaMatch: number;
        aliasMatch: boolean;
        specSimilarity: number;
      };
      specMatchDetails?: unknown;
    };
  };
}
