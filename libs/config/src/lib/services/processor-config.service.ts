import { Injectable } from "@nestjs/common";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { PROCESSOR_DEFAULTS, RESOLUTION_DEFAULTS } from "../review-collector";

export interface RelevanceConfig {
  minApprovalScore: number;
  opBypassScore: number;
  minReferenceEnabledScore: number;
  webSearchMinRelevance: number;
}

export interface PhaseAiConfig {
  model: string;
  thinking?: boolean;
  effort?: string;
}

export interface SubtreeBuilderConfig {
  softBudget: number;
  hardBudget: number;
  maxPlanNodes: number;
  maxDepth: number;
}

export interface IdentificationPhaseConfig extends PhaseAiConfig {
  missRateRetryThreshold: number;
}

export type DiscoveryPhaseConfig = IdentificationPhaseConfig;

export interface ExtractionPhaseConfig extends PhaseAiConfig {
  missRateRetryThreshold: number;
  maxFocusCategories: number;
  maxQuotesCeiling: number;
  maxQuotesPerProduct: number;
  minIngestionRelevance: number;
}

export type ExtractionConfig = ExtractionPhaseConfig;

export interface LabelingPhaseConfig extends PhaseAiConfig {
  maxNodes: number;
  strictSchema?: boolean;
}

export interface ValidationPhaseConfig extends PhaseAiConfig {
  softBudget: number;
  hardBudget: number;
  maxNodes: number;
  maxDepth: number;
}

export interface OpSummarizerPhaseConfig extends PhaseAiConfig {
  threshold: number;
}

export interface ImageAnalysisPhaseConfig {
  model: string;
}

export interface CheatSheetPhaseConfig {
  maxProducts: number;
  maxOpSlots: number;
  maxChars: number;
  minSlotsPerCategory: number;
  lowRefThreshold: number;
}

export interface ModerationConfig {
  minAutoApprovalScore: number;
  maxReferenceFlags: number;
  enableStructuredFixes: boolean;
  openSeverityReviewThreshold: number;
  /** Saturating cap for severity normalization in `moderationPriority`. Default 200. */
  severityCap: number;
  /** Relevance floor above which an unresolved reference triggers in_review. Default 50. */
  highRelevanceThreshold: number;
}

export interface CompositeScoringConfig {
  llmWeight: number;
  recencyWeight: number;
  recencyHalfLifeDays: number;
  lowCommentThreshold: number;
  lowCommentMultiplier: number;
  veryLowCommentThreshold: number;
  veryLowCommentMultiplier: number;
}

export interface RelevanceCalculationConfig {
  commentFetchLimit: number;
  commentSampleSize: number;
  minWeightedScore: number;
  overFetchMultiplier: number;
  model: string;
  thinking?: boolean;
  effort?: string;
  compositeScoring: CompositeScoringConfig;
}

export interface ThreadSelectionConfig {
  candidatePoolSize: number;
  minCategoryRelevance: number;
  maxCategoriesPerThread: number;
}

export interface PipelineProcessorConfig {
  maxIterations: number;
  maxParentProducts: number;
}

export interface ProcessorThresholds {
  relevance: RelevanceConfig;
  extraction: ExtractionConfig;
  moderation: ModerationConfig;
  pipeline: PipelineProcessorConfig;
  relevanceCalculation: RelevanceCalculationConfig;
  threadSelection: ThreadSelectionConfig;
}

/**
 * Service for managing processor threshold configurations.
 * Centralizes all hardcoded values like relevance scores, max iterations, etc.
 *
 * Defaults are loaded from processor.defaults.json in @ebike-backend/config.
 * Supports runtime configuration via DynamicConfigService.
 */
@Injectable()
export class ProcessorConfigService {
  constructor(private readonly dynamicConfig: DynamicConfigService) {}

  get relevance(): RelevanceConfig {
    const overrides = this.dynamicConfig.processor?.relevance;
    const defaults = PROCESSOR_DEFAULTS.relevance;
    return {
      minApprovalScore:
        overrides?.minApprovalScore ?? defaults.minApprovalScore,
      opBypassScore: overrides?.opBypassScore ?? defaults.opBypassScore,
      minReferenceEnabledScore:
        overrides?.minReferenceEnabledScore ??
        defaults.minReferenceEnabledScore,
      webSearchMinRelevance:
        overrides?.webSearchMinRelevance ?? defaults.webSearchMinRelevance,
    };
  }

  /** Pass-1 (wide identification) subtree builder — ~30 plan nodes. */
  get identificationBuilder(): SubtreeBuilderConfig {
    const overrides = this.dynamicConfig.processor?.identificationBuilder;
    const defaults = PROCESSOR_DEFAULTS.identificationBuilder;
    return {
      softBudget: overrides?.softBudget ?? defaults.softBudget,
      hardBudget: overrides?.hardBudget ?? defaults.hardBudget,
      maxPlanNodes: overrides?.maxPlanNodes ?? defaults.maxPlanNodes,
      maxDepth: overrides?.maxDepth ?? defaults.maxDepth,
    };
  }

  /** Pass-2 (small analysis) subtree builder — ~14 plan nodes. */
  get analysisBuilder(): SubtreeBuilderConfig {
    const overrides = this.dynamicConfig.processor?.analysisBuilder;
    const defaults = PROCESSOR_DEFAULTS.analysisBuilder;
    return {
      softBudget: overrides?.softBudget ?? defaults.softBudget,
      hardBudget: overrides?.hardBudget ?? defaults.hardBudget,
      maxPlanNodes: overrides?.maxPlanNodes ?? defaults.maxPlanNodes,
      maxDepth: overrides?.maxDepth ?? defaults.maxDepth,
    };
  }

  /** Pass-1 product discovery LLM step. */
  get discovery(): DiscoveryPhaseConfig {
    const overrides = this.dynamicConfig.processor?.discovery;
    const defaults = PROCESSOR_DEFAULTS.discovery;
    return {
      model: overrides?.model ?? defaults.model,
      ...(overrides?.thinking !== undefined && {
        thinking: overrides.thinking,
      }),
      ...(overrides?.effort !== undefined && { effort: overrides.effort }),
      missRateRetryThreshold:
        overrides?.missRateRetryThreshold ?? defaults.missRateRetryThreshold,
    };
  }

  get identification(): IdentificationPhaseConfig {
    const overrides = this.dynamicConfig.processor?.identification;
    const defaults = PROCESSOR_DEFAULTS.identification;
    return {
      model: overrides?.model ?? defaults.model,
      ...(overrides?.thinking !== undefined && {
        thinking: overrides.thinking,
      }),
      ...(overrides?.effort !== undefined && { effort: overrides.effort }),
      missRateRetryThreshold:
        overrides?.missRateRetryThreshold ?? defaults.missRateRetryThreshold,
    };
  }

  get extraction(): ExtractionPhaseConfig {
    const overrides = this.dynamicConfig.processor?.extraction;
    const defaults = PROCESSOR_DEFAULTS.extraction;
    return {
      model: overrides?.model ?? defaults.model,
      ...(overrides?.thinking !== undefined && {
        thinking: overrides.thinking,
      }),
      ...(overrides?.effort !== undefined && { effort: overrides.effort }),
      missRateRetryThreshold:
        overrides?.missRateRetryThreshold ?? defaults.missRateRetryThreshold,
      maxFocusCategories:
        overrides?.maxFocusCategories ?? defaults.maxFocusCategories,
      maxQuotesCeiling:
        overrides?.maxQuotesCeiling ?? defaults.maxQuotesCeiling,
      maxQuotesPerProduct:
        overrides?.maxQuotesPerProduct ?? defaults.maxQuotesPerProduct,
      minIngestionRelevance:
        overrides?.minIngestionRelevance ?? defaults.minIngestionRelevance,
    };
  }

  get labeling(): LabelingPhaseConfig {
    const overrides = this.dynamicConfig.processor?.labeling;
    const defaults = PROCESSOR_DEFAULTS.labeling;
    return {
      model: overrides?.model ?? defaults.model,
      ...(overrides?.thinking !== undefined && {
        thinking: overrides.thinking,
      }),
      ...(overrides?.effort !== undefined && { effort: overrides.effort }),
      maxNodes: overrides?.maxNodes ?? defaults.maxNodes,
      strictSchema: overrides?.strictSchema ?? defaults.strictSchema,
    };
  }

  get validation(): ValidationPhaseConfig {
    const overrides = this.dynamicConfig.processor?.validation;
    const defaults = PROCESSOR_DEFAULTS.validation;
    return {
      model: overrides?.model ?? defaults.model,
      ...(overrides?.thinking !== undefined && {
        thinking: overrides.thinking,
      }),
      ...(overrides?.effort !== undefined && { effort: overrides.effort }),
      softBudget: overrides?.softBudget ?? defaults.softBudget,
      hardBudget: overrides?.hardBudget ?? defaults.hardBudget,
      maxNodes: overrides?.maxNodes ?? defaults.maxNodes,
      maxDepth: overrides?.maxDepth ?? defaults.maxDepth,
    };
  }

  get opSummarizer(): OpSummarizerPhaseConfig {
    const overrides = this.dynamicConfig.processor?.opSummarizer;
    const defaults = PROCESSOR_DEFAULTS.opSummarizer;
    return {
      model: overrides?.model ?? defaults.model,
      ...(overrides?.thinking !== undefined && {
        thinking: overrides.thinking,
      }),
      ...(overrides?.effort !== undefined && { effort: overrides.effort }),
      threshold: overrides?.threshold ?? defaults.threshold,
    };
  }

  get imageAnalysis(): ImageAnalysisPhaseConfig {
    const overrides = this.dynamicConfig.processor?.imageAnalysis;
    const defaults = PROCESSOR_DEFAULTS.imageAnalysis;
    return {
      model: overrides?.model ?? defaults.model,
    };
  }

  get cheatSheet(): CheatSheetPhaseConfig {
    const overrides = this.dynamicConfig.processor?.cheatSheet;
    const defaults = PROCESSOR_DEFAULTS.cheatSheet;
    return {
      maxProducts: overrides?.maxProducts ?? defaults.maxProducts,
      maxOpSlots: overrides?.maxOpSlots ?? defaults.maxOpSlots,
      maxChars: overrides?.maxChars ?? defaults.maxChars,
      minSlotsPerCategory:
        overrides?.minSlotsPerCategory ?? defaults.minSlotsPerCategory,
      lowRefThreshold: overrides?.lowRefThreshold ?? defaults.lowRefThreshold,
    };
  }

  get moderation(): ModerationConfig {
    const overrides = this.dynamicConfig.processor?.moderation;
    const defaults = PROCESSOR_DEFAULTS.moderation;
    return {
      minAutoApprovalScore:
        overrides?.minAutoApprovalScore ?? defaults.minAutoApprovalScore,
      maxReferenceFlags:
        overrides?.maxReferenceFlags ?? defaults.maxReferenceFlags,
      enableStructuredFixes:
        overrides?.enableStructuredFixes ?? defaults.enableStructuredFixes,
      openSeverityReviewThreshold:
        overrides?.openSeverityReviewThreshold ??
        (defaults as { openSeverityReviewThreshold?: number })
          .openSeverityReviewThreshold ??
        50,
      severityCap:
        overrides?.severityCap ??
        (defaults as { severityCap?: number }).severityCap ??
        200,
      highRelevanceThreshold:
        overrides?.highRelevanceThreshold ??
        (defaults as { highRelevanceThreshold?: number })
          .highRelevanceThreshold ??
        50,
    };
  }

  get pipeline(): PipelineProcessorConfig {
    const overrides = this.dynamicConfig.processor?.pipeline;
    const defaults = PROCESSOR_DEFAULTS.pipeline;
    return {
      maxIterations: overrides?.maxIterations ?? defaults.maxIterations,
      maxParentProducts:
        overrides?.maxParentProducts ?? defaults.maxParentProducts,
    };
  }

  get relevanceCalculation(): RelevanceCalculationConfig {
    const overrides = this.dynamicConfig.processor?.relevanceCalculation;
    const defaults = PROCESSOR_DEFAULTS.relevanceCalculation;
    const compositeOverrides = overrides?.compositeScoring;
    const compositeDefaults = defaults.compositeScoring;
    return {
      commentFetchLimit:
        overrides?.commentFetchLimit ?? defaults.commentFetchLimit,
      commentSampleSize:
        overrides?.commentSampleSize ?? defaults.commentSampleSize,
      minWeightedScore:
        overrides?.minWeightedScore ?? defaults.minWeightedScore,
      overFetchMultiplier:
        overrides?.overFetchMultiplier ?? defaults.overFetchMultiplier,
      model: overrides?.model ?? defaults.model,
      ...(overrides?.thinking !== undefined && {
        thinking: overrides.thinking,
      }),
      ...(overrides?.effort !== undefined && { effort: overrides.effort }),
      compositeScoring: {
        llmWeight: compositeOverrides?.llmWeight ?? compositeDefaults.llmWeight,
        recencyWeight:
          compositeOverrides?.recencyWeight ?? compositeDefaults.recencyWeight,
        recencyHalfLifeDays:
          compositeOverrides?.recencyHalfLifeDays ??
          compositeDefaults.recencyHalfLifeDays,
        lowCommentThreshold:
          compositeOverrides?.lowCommentThreshold ??
          compositeDefaults.lowCommentThreshold,
        lowCommentMultiplier:
          compositeOverrides?.lowCommentMultiplier ??
          compositeDefaults.lowCommentMultiplier,
        veryLowCommentThreshold:
          compositeOverrides?.veryLowCommentThreshold ??
          compositeDefaults.veryLowCommentThreshold,
        veryLowCommentMultiplier:
          compositeOverrides?.veryLowCommentMultiplier ??
          compositeDefaults.veryLowCommentMultiplier,
      },
    };
  }

  get threadSelection(): ThreadSelectionConfig {
    const overrides = this.dynamicConfig.processor?.threadSelection;
    const defaults = PROCESSOR_DEFAULTS.threadSelection;
    return {
      candidatePoolSize:
        overrides?.candidatePoolSize ?? defaults.candidatePoolSize,
      minCategoryRelevance:
        overrides?.minCategoryRelevance ?? defaults.minCategoryRelevance,
      maxCategoriesPerThread:
        overrides?.maxCategoriesPerThread ?? defaults.maxCategoriesPerThread,
    };
  }

  get thresholds(): ProcessorThresholds {
    return {
      relevance: this.relevance,
      extraction: this.extraction,
      moderation: this.moderation,
      pipeline: this.pipeline,
      relevanceCalculation: this.relevanceCalculation,
      threadSelection: this.threadSelection,
    };
  }

  get webSearchRelevanceGate(): number {
    return (
      this.dynamicConfig.resolution?.webSearchRelevanceGate ??
      RESOLUTION_DEFAULTS.webSearchRelevanceGate
    );
  }
}
