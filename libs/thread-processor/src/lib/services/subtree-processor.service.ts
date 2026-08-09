import { Injectable } from "@nestjs/common";
import {
  collectAllFeatures,
  CommentStatus,
  CommentTree,
  getPrimaryModel,
  isHandsonExperience,
  ProductReferenceRepository,
  resolveMediaContent,
  Thread,
  ThreadRepository,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { ChatTraceData, DebugTraceService } from "@ebike-backend/debug";
import { ReferenceRelevanceService } from "@ebike-backend/relevance";
import { PipelineMetricsService } from "@ebike-backend/metrics";
import { compact, isEmpty, sumBy } from "lodash";
import { MediaAnalyzerService } from "./media-analyzer.service";
import {
  SubtreeContextBuilderService,
  SubtreeBuilderService,
  OPSummarizerService,
  SubtreeExtractionService,
  ExtractionTraceCall,
  QuoteLabelingService,
  LabelingTraceCall,
  ProductRegistryService,
  RegistryPreloadService,
  WideIdentificationPassService,
  WideIdentificationConfig,
} from "./index";
import { ProductResolutionOrchestratorService } from "./product-resolution-orchestrator.service";
import { isCategoryResolvable } from "./reference-to-resolution-input";
import { SubtreeValidationStageService } from "./validation/subtree-validation-stage.service";
import { SubtreeModerationService } from "./moderation/subtree-moderation.service";
import { RegistryOptions, Subtree, ThreadContext } from "../models";
import { LLMMappedProduct } from "../schemas";
import {
  DiscoveryPhaseConfig,
  ExtractionPhaseConfig,
  IdentificationPhaseConfig,
  ImageAnalysisPhaseConfig,
  LabelingPhaseConfig,
  OpSummarizerPhaseConfig,
  ProcessorConfigService,
  SubtreeBuilderConfig,
  ValidationPhaseConfig,
} from "@ebike-backend/config";

// ─── Config Types ────────────────────────────────────────────────────────────

interface ProcessingConfig {
  identificationBuilder: SubtreeBuilderConfig;
  analysisBuilder: SubtreeBuilderConfig;
  discovery: DiscoveryPhaseConfig;
  identification: IdentificationPhaseConfig;
  extraction: ExtractionPhaseConfig;
  labeling: LabelingPhaseConfig;
  validation: ValidationPhaseConfig;
  opSummarizer: OpSummarizerPhaseConfig;
  imageAnalysis: ImageAnalysisPhaseConfig;
  registryOpts: RegistryOptions;
}

export interface ThreadProcessResult {
  subtreeCount: number;
  distinctProductsInRegistry: number;
  productMentionsIdentified: number;
  opSummarized: boolean;
}

// ─── Per-phase status eligibility ─────────────────────────────────────────────
// Each phase only acts on PLAN nodes whose status is in its input set. The
// orchestrator projects the subtree per phase via projectSubtreeForPhase().

const IDENTIFICATION_INPUT = new Set<CommentStatus>([CommentStatus.NEW]);
const EXTRACTION_INPUT = new Set<CommentStatus>([CommentStatus.IDENTIFIED]);
const LABELING_INPUT = new Set<CommentStatus>([CommentStatus.EXTRACTED]);
const VALIDATION_INPUT = new Set<CommentStatus>([CommentStatus.LABELED]);
const RELEVANCE_INPUT = new Set<CommentStatus>([CommentStatus.VALIDATED]);
const MODERATION_INPUT = new Set<CommentStatus>([
  CommentStatus.RELEVANCE_CALCULATED,
]);

const ANY_PHASE_INPUT = new Set<CommentStatus>([
  ...IDENTIFICATION_INPUT,
  ...EXTRACTION_INPUT,
  ...LABELING_INPUT,
  ...VALIDATION_INPUT,
  ...RELEVANCE_INPUT,
  ...MODERATION_INPUT,
]);

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class SubtreeProcessorService {
  private readonly logger = new CustomLogger(SubtreeProcessorService.name);

  constructor(
    // Lib-layer services
    private readonly contextBuilder: SubtreeContextBuilderService,
    private readonly subtreeBuilder: SubtreeBuilderService,
    private readonly mediaAnalyzer: MediaAnalyzerService,
    private readonly opSummarizer: OPSummarizerService,
    private readonly wideIdentificationPass: WideIdentificationPassService,
    private readonly registryPreload: RegistryPreloadService,
    private readonly subtreeExtraction: SubtreeExtractionService,
    private readonly quoteLabeling: QuoteLabelingService,
    private readonly subtreeValidationStage: SubtreeValidationStageService,
    private readonly subtreeModeration: SubtreeModerationService,
    private readonly productRegistry: ProductRegistryService,
    private readonly productResolutionOrchestrator: ProductResolutionOrchestratorService,
    // Domain services
    private readonly referenceRelevance: ReferenceRelevanceService,
    // Infrastructure
    private readonly threadRepository: ThreadRepository,
    private readonly commentRepository: UserCommentRepository,
    private readonly productReferenceRepository: ProductReferenceRepository,
    private readonly dynamicConfig: DynamicConfigService,
    private readonly processorConfig: ProcessorConfigService,
    private readonly debugTrace: DebugTraceService,
    private readonly pipelineMetrics: PipelineMetricsService,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Process a thread end-to-end: Phase 0 init → Phase 1 build subtrees →
   * per-subtree loop (Phase 2–8).
   *
   * Returns aggregate counts that only exist in memory during processing —
   * everything else is derivable from the database after completion.
   */
  async process(
    threadId: string,
    tree: CommentTree,
  ): Promise<ThreadProcessResult> {
    const threadStart = Date.now();
    const config = await this.loadConfig();

    // ── Record config snapshot ────────────────────────────────────────────
    await this.recordConfigSnapshot(threadId, config);

    // ── Phase 0: Initialize & Recover ────────────────────────────────────
    const phaseStart = Date.now();
    const { thread, context, op } = await this.contextBuilder.build(
      threadId,
      tree,
      {
        registryOpts: config.registryOpts,
        opSummaryThreshold: config.opSummarizer.threshold,
        maxFocusCategories: config.extraction.maxFocusCategories,
      },
    );

    this.recordPhaseDuration("init", phaseStart);
    await this.recordCategoryFocusTrace(threadId, context);

    // ── Phase 1: Build Subtree Map ───────────────────────────────────────
    const phase1Start = Date.now();

    // Phase 1a: OP summarization if needed
    let opSummarized = false;
    if (context.opSection === null) {
      const mediaContent = resolveMediaContent(op.media);
      const bodyForSummarization = mediaContent
        ? `${op.body}\n${mediaContent}`
        : op.body;
      let opSummaryTraceData: ChatTraceData | undefined;
      const summary = await this.opSummarizer.summarizeIfNeeded(
        bodyForSummarization,
        thread.opSummary,
        {
          opSummaryThreshold: config.opSummarizer.threshold,
          opSummarizerModel: config.opSummarizer.model,
          thinking: config.opSummarizer.thinking,
          effort: config.opSummarizer.effort,
        },
        threadId,
        (data) => {
          opSummaryTraceData = data;
        },
      );
      const wasSummarized = summary !== thread.opSummary;
      if (wasSummarized) {
        thread.opSummary = summary;
        await this.threadRepository.repo.update(thread.id, {
          opSummary: summary,
        });
        this.pipelineMetrics.recordOpSummarization("summarized");
        opSummarized = true;
      } else {
        this.pipelineMetrics.recordOpSummarization("skipped");
      }
      context.opSection = `@${op.authorName ?? "[OP]"}: "${summary}"`;
      await this.recordOpSummarizationTrace(
        thread.id,
        op.body,
        summary,
        wasSummarized,
        config.opSummarizer.model,
        opSummaryTraceData,
      );
    }

    // Rerun pre-load: hydrate the registry from a PRIOR run's resolved refs so
    // pass-1 discovery can judge known-vs-genuinely-new before its first LLM
    // call. No-op on a fresh thread.
    this.registryPreload.preload(context);

    // Analyze media on NEW comments once, thread-wide, before pass 1 — discovery
    // and identification render comment bodies + media content.
    await this.analyzeNewCommentMedia(context, config, threadId);

    const validSpecNames = this.collectValidSpecNames(context);

    // ══ PASS 1 — Wide Identification (~30) — owns ALL resolution ══════════
    const pass1Map = this.subtreeBuilder.buildSubtrees(tree, context, {
      softBudget: config.identificationBuilder.softBudget,
      hardBudget: config.identificationBuilder.hardBudget,
      maxPlanNodes: config.identificationBuilder.maxPlanNodes,
      maxDepth: config.identificationBuilder.maxDepth,
    });
    const pass1Subtrees = [pass1Map.opSubtree, ...pass1Map.subtrees];
    this.recordPhaseDuration("subtree_building", phase1Start);
    await this.recordSubtreeBuildingTrace(threadId, pass1Subtrees, config);
    this.logger.log(
      `Pass 1: ${pass1Subtrees.length} wide subtrees built for thread ${threadId}`,
      { threadId },
    );

    let productMentionsIdentified = 0;
    const wideConfig: WideIdentificationConfig = {
      threadId,
      discovery: config.discovery,
      identification: config.identification,
      validSpecNames,
      registryOpts: config.registryOpts,
    };
    for (let i = 0; i < pass1Subtrees.length; i++) {
      const subtree = pass1Subtrees[i];
      if (subtree.planNodes.length === 0) continue;
      if (!this.hasAnyWork(subtree)) {
        this.productRegistry.replayProcessedSubtree(
          subtree,
          context,
          config.registryOpts,
        );
        continue;
      }
      try {
        const result = await this.wideIdentificationPass.run(
          subtree,
          thread,
          context,
          wideConfig,
        );
        productMentionsIdentified += result.mentionsIdentified;
      } catch (error) {
        this.logger.error(
          `Error in pass-1 subtree ${subtree.id}, stopping: ${error}`,
        );
        throw error;
      }
      this.logger.log(`Pass 1: ${i + 1}/${pass1Subtrees.length} subtrees`, {
        threadId,
      });
    }

    // ══ regroup — fresh small grouping over the whole thread ══════════════
    const pass2Map = this.subtreeBuilder.buildSubtrees(tree, context, {
      softBudget: config.analysisBuilder.softBudget,
      hardBudget: config.analysisBuilder.hardBudget,
      maxPlanNodes: config.analysisBuilder.maxPlanNodes,
      maxDepth: config.analysisBuilder.maxDepth,
    });
    const allSubtrees = [pass2Map.opSubtree, ...pass2Map.subtrees];
    this.pipelineMetrics.recordThreadSubtreeCount(allSubtrees.length);

    // ══ PASS 2 — Small Analysis (~14) — NO resolution ════════════════════
    const total = allSubtrees.length;
    let processed = 0;
    for (let subtreeIndex = 0; subtreeIndex < total; subtreeIndex++) {
      const subtree = allSubtrees[subtreeIndex];

      if (subtree.planNodes.length === 0) {
        processed++;
        continue;
      }

      if (!this.hasAnyWork(subtree)) {
        // Replay-only subtree: every PLAN node is terminal. Evolve the
        // registry/cheat sheet from existing refs without LLM calls.
        this.productRegistry.replayProcessedSubtree(
          subtree,
          context,
          config.registryOpts,
        );
        processed++;
        continue;
      }

      try {
        await this.runAnalysisSubtree(
          subtreeIndex,
          subtree,
          tree,
          thread,
          context,
          config,
          validSpecNames,
        );
      } catch (error) {
        this.logger.error(
          `Error in pass-2 subtree ${subtree.id}, stopping subsequent subtrees: ${error}`,
        );
        throw error;
      }

      processed++;
      this.logger.log(`Pass 2: ${processed}/${total} subtrees processed`, {
        threadId,
      });
    }

    // ── End-of-thread productLinkId backfill ─────────────────────────────
    // Propagate any product resolved anywhere in the thread to its still-
    // unresolved group members so the review phase materialises them
    // immediately — no extra search.
    await this.productResolutionOrchestrator.backfillLinkGroups(
      allSubtrees,
      thread,
      context,
    );

    // ── Final metrics ────────────────────────────────────────────────────
    this.pipelineMetrics.recordRegistryProductCount(
      context.productRegistry.size,
    );
    this.pipelineMetrics.recordRegistryCheatSheetChars(
      context.cheatSheetString?.length ?? 0,
    );
    this.pipelineMetrics.recordThreadProcessingDuration(
      (Date.now() - threadStart) / 1000,
    );

    // Sum and record per-thread LLM cost from accumulated in-memory costs
    this.recordThreadCost(threadId);

    return {
      subtreeCount: allSubtrees.length,
      distinctProductsInRegistry: context.productRegistry.size,
      productMentionsIdentified,
      opSummarized,
    };
  }

  // ─── Per-Subtree Processing ────────────────────────────────────────────────

  /**
   * Pass-2 analysis loop body for one small subtree: extraction → registry
   * update → labeling → validation → relevance → moderation. NO identification
   * or resolution — those ran in pass 1 (`WideIdentificationPassService`).
   * PLAN nodes are projected per phase; `IDENTIFIED` comments are extraction's
   * input.
   */
  private async runAnalysisSubtree(
    subtreeIndex: number,
    subtree: Subtree,
    tree: CommentTree,
    thread: Thread,
    context: ThreadContext,
    config: ProcessingConfig,
    validSpecNames: Set<string>,
  ): Promise<void> {
    const { registryOpts } = config;

    // ── Phase 4: Extraction (IDENTIFIED → EXTRACTED) ────────────────────
    // Project from the subtree by EXTRACTION_INPUT so only IDENTIFIED comments
    // are extracted; SKIPPED/terminal comments render as CONTEXT.
    const extractionView = this.projectSubtreeForPhase(
      subtree,
      EXTRACTION_INPUT,
    );
    if (extractionView.planNodes.length > 0) {
      const extractionStatusBefore = new Map(
        extractionView.planNodes.map((n) => [n.comment.id, n.comment.status]),
      );
      const phaseStart = Date.now();
      const extractionResult = await this.subtreeExtraction.processSubtree(
        extractionView,
        context,
        {
          threadId: thread.id,
          extractionModel: config.extraction.model,
          extractionMissRateRetryThreshold:
            config.extraction.missRateRetryThreshold,
          maxQuotesCeiling: config.extraction.maxQuotesCeiling,
          thinking: config.extraction.thinking,
          effort: config.extraction.effort,
          validSpecNames,
          planProductAnnotations:
            this.buildPlanProductAnnotations(extractionView),
          isOpSubtree: subtree.isOpSubtree,
        },
      );
      await this.recordSubtreeExtractionTraces(
        thread.id,
        extractionView,
        context,
        subtreeIndex,
        extractionStatusBefore,
        extractionResult.traceCalls,
      );
      this.recordDeferredClassificationMetrics(extractionView);
      this.recordPhaseDuration("reference_extraction", phaseStart);

      // Force-advance any IDENTIFIED PLAN node the extraction LLM silently
      // dropped — leaving it at IDENTIFIED would exclude it from the rest of
      // pass 2 (mirrors labeling's unconditional advance). Resolution Backfill
      // still resolves its refs later if unresolved.
      const stuck = extractionView.planNodes
        .map((node) => node.comment)
        .filter((comment) => comment.status === CommentStatus.IDENTIFIED);
      if (stuck.length > 0) {
        for (const comment of stuck) {
          comment.status = CommentStatus.EXTRACTED;
        }
        await this.commentRepository.saveAll(stuck);
      }
    }

    // ── Phase 4c: Full Registry Update — FULL subtree contributes ───────
    {
      const phaseStart = Date.now();
      const registrySizeBefore = context.productRegistry.size;
      this.updateRegistry(subtree, context, registryOpts);
      const subtreeRefs = subtree.planNodes.flatMap(
        (node) => node.comment.productReferences ?? [],
      );
      const registryHitsThisSubtree = subtreeRefs.filter(
        (reference) => reference.searchContext?.options?.useEmbedding === false,
      ).length;
      const webSearchesThisSubtree = subtreeRefs.filter((reference) => {
        const ctx = reference.searchContext;
        if (!ctx) return false;
        // v2 lib uses webResearch.queries; legacy lib uses webSearchAttempts.
        if ("webResearch" in ctx) {
          return (ctx.webResearch?.queries.length ?? 0) > 0;
        }
        if ("webSearchAttempts" in ctx) {
          return (
            ((ctx.webSearchAttempts as unknown[] | undefined)?.length ?? 0) > 0
          );
        }
        return false;
      }).length;
      await this.recordRegistryUpdateTrace(
        thread.id,
        subtreeIndex,
        registrySizeBefore,
        context,
        registryHitsThisSubtree,
        webSearchesThisSubtree,
      );
      this.recordPhaseDuration("registry_update", phaseStart);
    }

    // ── Phase 4d: Quote Labeling (EXTRACTED → LABELED) ──────────────────
    // Every EXTRACTED PLAN node advances to LABELED unconditionally — the
    // labeling LLM emitting no labels for a comment is a valid outcome (no
    // labelable evidence) and must not strand the comment. Refs without
    // quotes are also fine to advance: the comment passed extraction, the
    // labeling step is now complete for it.
    await this.runPhase(subtree, LABELING_INPUT, async (view) => {
      const phaseStart = Date.now();
      const labelingResult = await this.quoteLabeling.processSubtree(
        view,
        context,
        {
          threadId: thread.id,
          labelingModel: config.labeling.model,
          thinking: config.labeling.thinking,
          effort: config.labeling.effort,
          strictSchema: config.labeling.strictSchema,
        },
      );
      await this.recordLabelingTraces(
        thread.id,
        subtreeIndex,
        labelingResult.traceCalls,
      );

      const advanced = view.planNodes.map((node) => {
        node.comment.status = CommentStatus.LABELED;
        return node.comment;
      });
      if (advanced.length > 0) {
        await this.commentRepository.saveAll(advanced);
      }

      this.recordPhaseDuration("labeling", phaseStart);
    });

    // ── Phase 5: Validation (LABELED → VALIDATED) ───────────────────────
    await this.runPhase(subtree, VALIDATION_INPUT, async (view) => {
      const phaseStart = Date.now();
      await this.subtreeValidationStage.validate(view, tree, context, {
        threadId: thread.id,
        subtreeIndex,
        validationModel: config.validation.model,
        validationSoftBudget: config.validation.softBudget,
        validationHardBudget: config.validation.hardBudget,
        validationMaxNodes: config.validation.maxNodes,
        validationMaxDepth: config.validation.maxDepth,
        thinking: config.validation.thinking,
        effort: config.validation.effort,
      });
      this.recordPhaseDuration("reference_validation", phaseStart);
    });

    // ── Phase 6: Relevance (VALIDATED → RELEVANCE_CALCULATED) ───────────
    await this.runPhase(subtree, RELEVANCE_INPUT, async (view) => {
      const phaseStart = Date.now();
      await this.processRelevance(view, thread);
      this.recordPhaseDuration("relevance_scoring", phaseStart);
    });

    // ── Phase 7: Moderation (RELEVANCE_CALCULATED → terminal) ───────────
    await this.runPhase(subtree, MODERATION_INPUT, async (view) => {
      const phaseStart = Date.now();
      await this.subtreeModeration.moderate(view, {
        threadId: thread.id,
        subtreeIndex,
      });
      this.recordPhaseDuration("comment_moderation", phaseStart);
    });
  }

  // ─── Per-Phase Projection Helpers ───────────────────────────────────────────

  /**
   * Project a subtree to a phase-specific view. The full set of comments stays
   * in `nodes` (so the LLM prompt still renders every comment for context),
   * but only comments at the phase's input status remain in `planNodes`. The
   * rest are demoted to CONTEXT — they appear in the rendered conversation
   * tree as non-actionable surrounding text.
   */
  private projectSubtreeForPhase(
    subtree: Subtree,
    eligibleStatuses: Set<CommentStatus>,
  ): Subtree {
    const projectedNodes = subtree.nodes.map((node) => {
      if (node.nodeType !== "PLAN") return node;
      if (eligibleStatuses.has(node.comment.status)) return node;
      return { ...node, nodeType: "CONTEXT" as const };
    });
    return {
      id: subtree.id,
      isOpSubtree: subtree.isOpSubtree,
      nodes: projectedNodes,
      planNodes: projectedNodes.filter((n) => n.nodeType === "PLAN"),
    };
  }

  /**
   * Project the subtree for a phase and run the phase function only if the
   * projected view has at least one PLAN node.
   */
  private async runPhase(
    subtree: Subtree,
    eligibleStatuses: Set<CommentStatus>,
    run: (view: Subtree) => Promise<void>,
  ): Promise<void> {
    const view = this.projectSubtreeForPhase(subtree, eligibleStatuses);
    if (view.planNodes.length === 0) return;
    await run(view);
  }

  /** True when the comment's status is the input of any LLM phase. */
  private isAnyPhaseInput(status: CommentStatus): boolean {
    return ANY_PHASE_INPUT.has(status);
  }

  /** A subtree has work when any PLAN node sits at a phase input status.
   *  Otherwise it is replay-only (registry contribution without LLM calls). */
  private hasAnyWork(subtree: Subtree): boolean {
    return subtree.planNodes.some((node) =>
      this.isAnyPhaseInput(node.comment.status),
    );
  }

  /** Analyze media on NEW comments thread-wide before pass 1. Media content is
   *  rendered into discovery/identification (and later extraction) prompts, so
   *  it must be resolved before any of them run. Failures are logged + skipped. */
  private async analyzeNewCommentMedia(
    context: ThreadContext,
    config: ProcessingConfig,
    threadId: string,
  ): Promise<void> {
    const pending = context
      .getAllComments()
      .filter((comment) => comment.status === CommentStatus.NEW)
      .filter((comment) =>
        comment.media?.some((m) => !isEmpty(m.url) && !m.content),
      );

    for (const comment of pending) {
      const media = comment.media;
      if (!media) continue;
      try {
        comment.media = await this.mediaAnalyzer.analyze({
          media,
          model: config.imageAnalysis.model,
          threadId,
        });
        await this.commentRepository.repo.update(comment.id, {
          media: comment.media,
        });
      } catch (error) {
        this.logger.warn("Comment media analysis failed, skipping", {
          commentId: comment.id,
          error,
        });
      }
    }
  }

  /** Valid spec-name whitelist for the thread's focus categories. */
  private collectValidSpecNames(context: ThreadContext): Set<string> {
    return new Set(
      context.categoryConfigs.flatMap(
        (categoryConfig) =>
          categoryConfig.promptConfig.validSpecs?.map((s) => s.name) ?? [],
      ),
    );
  }

  /** Rebuild per-comment extraction annotations from persisted refs (pass 1
   *  created them; pass 2 reads them after the regroup). */
  private buildPlanProductAnnotations(
    view: Subtree,
  ): Map<string, LLMMappedProduct[]> {
    const annotations = new Map<string, LLMMappedProduct[]>();
    for (const node of view.planNodes) {
      const refs = node.comment.productReferences ?? [];
      const products = compact(
        refs.map((ref): LLMMappedProduct | null => {
          const identification = ref.context?.identification;
          if (!identification) return null;
          return {
            type: identification.type ?? "explicit",
            brand: identification.brand ?? "",
            model: identification.model ?? "",
            contentQuality: identification.contentQuality ?? "medium",
            linkId: identification.productLinkLabel ?? "",
            ...(identification.categoryHint && {
              categoryHint: identification.categoryHint,
            }),
            ...(identification.specs && { specs: identification.specs }),
            ...(identification.referenceModel && {
              referenceModel: identification.referenceModel,
            }),
            ...(identification.modelClues && {
              modelClues: identification.modelClues,
            }),
            ...(identification.variantClues && {
              variantClues: identification.variantClues,
            }),
          };
        }),
      );
      if (products.length > 0) annotations.set(node.comment.id, products);
    }
    return annotations;
  }

  // ─── Phase 5: Relevance ────────────────────────────────────────────────────

  private async processRelevance(
    subtree: Subtree,
    thread: Thread,
  ): Promise<void> {
    const { minApprovalScore, minReferenceEnabledScore } =
      this.processorConfig.relevance;

    for (const node of subtree.planNodes) {
      const comment = node.comment;
      if (comment.status !== CommentStatus.VALIDATED) continue;

      const allRefs = comment.productReferences ?? [];

      const refTraceEntries: Array<{
        refId: string;
        score: number;
        factors: import("@ebike-backend/database").RelevanceFactors;
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
      }> = [];

      let maxEnabledRelevance = 0;
      let maxOverallRelevance = 0;
      for (const ref of allRefs) {
        const { score: refScore, factors } =
          this.referenceRelevance.calculateRelevance(
            ref,
            undefined,
            comment.body,
            comment.upvotes,
          );
        ref.relevance = refScore;
        if (ref.context) {
          ref.context.relevance = { factors };
        }
        const quotes = ref.quotes ?? [];
        const quoteCount = quotes.length;
        const hasQualityQuotes = quotes.some((q) => q.quality !== "low");
        const isFirstHand =
          ref.experience !== undefined && isHandsonExperience(ref.experience);
        ref.enabled =
          hasQualityQuotes &&
          (isFirstHand || refScore >= minReferenceEnabledScore);
        if (ref.enabled) {
          maxEnabledRelevance = Math.max(maxEnabledRelevance, refScore);
        }
        maxOverallRelevance = Math.max(maxOverallRelevance, refScore);

        const featureCount = collectAllFeatures(ref).length;
        const contentScore =
          factors.depthMultiplier *
          factors.quoteQualityMultiplier *
          factors.sentimentMultiplier *
          factors.featureUseCaseMultiplier *
          (factors.intentMultiplier ?? 1.0) *
          85;

        refTraceEntries.push({
          refId: ref.id,
          score: refScore,
          factors,
          inputs: {
            depth: ref.depth ?? "",
            sentiment: ref.sentiment ?? "",
            experience: ref.experience ?? "",
            intents: (ref.intents ?? []) as string[],
            quoteCount,
            validQuoteCount: quoteCount,
            featureCount,
            useCaseCount: ref.useCases?.length ?? 0,
          },
          contentScore,
          enabled: ref.enabled,
        });
      }

      comment.relevance =
        maxEnabledRelevance > 0 ? maxEnabledRelevance : maxOverallRelevance;

      comment.status = CommentStatus.RELEVANCE_CALCULATED;

      if (allRefs.length > 0) {
        await this.productReferenceRepository.saveAll(allRefs);
      }
      await this.commentRepository.save(comment);
      await this.recordRelevanceTrace(
        thread.id,
        comment.id,
        comment.relevance ?? 0,
        minApprovalScore,
        comment.status,
        refTraceEntries,
      );
    }
  }

  // ─── Phase 5: Resolution ──────────────────────────────────────────────────

  private updateRegistry(
    subtree: Subtree,
    context: ThreadContext,
    registryOpts: RegistryOptions,
  ): void {
    const allRefs = subtree.planNodes.flatMap(
      (n) => n.comment.productReferences ?? [],
    );
    const allComments = subtree.planNodes.map((n) => n.comment);

    // IMPORTANT: shift BEFORE upsert so new entries land as 'latest'
    this.productRegistry.shiftRecencyFlags(context);

    this.productRegistry.upsertFromReferences(
      allRefs,
      subtree.isOpSubtree,
      context,
    );

    this.productRegistry.updateAuthorAffinity(allComments, context);

    this.productRegistry.renderCheatSheet(context, registryOpts);
  }

  // ─── Config & Metrics Helpers ──────────────────────────────────────────────

  private async loadConfig(): Promise<ProcessingConfig> {
    const cheatSheet = this.processorConfig.cheatSheet;
    return {
      identificationBuilder: this.processorConfig.identificationBuilder,
      analysisBuilder: this.processorConfig.analysisBuilder,
      discovery: this.processorConfig.discovery,
      identification: this.processorConfig.identification,
      extraction: this.processorConfig.extraction,
      labeling: this.processorConfig.labeling,
      validation: this.processorConfig.validation,
      opSummarizer: this.processorConfig.opSummarizer,
      imageAnalysis: this.processorConfig.imageAnalysis,
      registryOpts: {
        maxProducts: cheatSheet.maxProducts,
        maxOpSlots: cheatSheet.maxOpSlots,
        maxChars: cheatSheet.maxChars,
        lowRefThreshold: cheatSheet.lowRefThreshold,
        minSlotsPerCategory: cheatSheet.minSlotsPerCategory,
      },
    };
  }

  private recordPhaseDuration(phase: string, startMs: number): void {
    this.pipelineMetrics.recordThreadPhaseDuration(
      phase,
      (Date.now() - startMs) / 1000,
    );
  }

  private recordDeferredClassificationMetrics(subtree: Subtree): void {
    for (const node of subtree.planNodes) {
      const references = node.comment.productReferences ?? [];
      for (const reference of references) {
        // "Deferred" is now derived: a ref whose (non-null) category is disabled
        // waits for Resolution Backfill rather than resolving inline.
        if (isCategoryResolvable(reference)) {
          this.pipelineMetrics.recordDeferredRefClassified("actionable");
        } else {
          // Has a (disabled) category by definition of !isCategoryResolvable.
          this.pipelineMetrics.recordDeferredRefClassified("deferred");
        }
      }
    }
  }

  private async recordConfigSnapshot(
    threadId: string,
    config: ProcessingConfig,
  ): Promise<void> {
    try {
      if (!this.dynamicConfig.debug?.traceEnabled) return;

      await this.debugTrace.record({
        threadId,
        step: "config_snapshot",
        statusBefore: "N/A",
        statusAfter: "N/A",
        durationMs: 0,
        data: {
          summary: "Pipeline configuration snapshot",
          configSnapshot: {
            identificationBuilder: config.identificationBuilder,
            analysisBuilder: config.analysisBuilder,
            discovery: config.discovery,
            identification: config.identification,
            extraction: config.extraction,
            labeling: config.labeling,
            validation: config.validation,
            opSummarizer: config.opSummarizer,
            imageAnalysis: config.imageAnalysis,
            registryOpts: config.registryOpts,
            processor: this.processorConfig.thresholds,
          },
        },
      });
    } catch (error) {
      this.logger.warn("Failed to record config snapshot trace", { error });
    }
  }

  /** Record category focus info as a separate trace for easy inspection. */
  private async recordCategoryFocusTrace(
    threadId: string,
    context: ThreadContext,
  ): Promise<void> {
    try {
      if (!this.dynamicConfig.debug?.traceEnabled) return;
      if (context.categoryConfigs.length === 0) return;

      await this.debugTrace.record({
        threadId,
        step: "category_focus",
        statusBefore: "N/A",
        statusAfter: "N/A",
        durationMs: 0,
        data: {
          summary: `Category focus (top ${context.categoryConfigs.length} by rank): ${context.categoryConfigs.map((c) => c.categoryName).join(", ")}`,
          categoryFocus: context.categoryConfigs.map((c) => ({
            categoryId: c.categoryId,
            categoryName: c.categoryName,
            confidence: c.confidence,
            hasPromptConfig: !!(
              c.promptConfig.specialInstructions ||
              c.promptConfig.validSpecs?.length
            ),
          })),
        },
      });
    } catch (error) {
      this.logger.warn("Failed to record config snapshot trace", { error });
    }
  }

  private recordThreadCost(threadId: string): void {
    try {
      const totalCost = this.debugTrace.peekThreadCost(threadId);

      if (totalCost > 0) {
        this.pipelineMetrics.recordThreadCost(totalCost);
        this.logger.log(
          `Thread ${threadId} total cost: $${totalCost.toFixed(4)}`,
          {
            threadId,
          },
        );
      }
    } catch (error) {
      this.logger.warn("Failed to record thread cost", { threadId, error });
    }
  }

  private async recordSubtreeBuildingTrace(
    threadId: string,
    subtrees: Subtree[],
    config: ProcessingConfig,
  ): Promise<void> {
    const totalPlanNodes = subtrees.reduce(
      (sum, subtree) => sum + subtree.planNodes.length,
      0,
    );
    const totalContextNodes = subtrees.reduce(
      (sum, subtree) =>
        sum + subtree.nodes.filter((n) => n.nodeType === "CONTEXT").length,
      0,
    );

    await this.debugTrace.record({
      threadId,
      step: "subtree_building",
      statusBefore: "N/A",
      statusAfter: "N/A",
      durationMs: 0,
      cost: 0,
      data: {
        summary: `Built ${subtrees.length} subtrees`,
        subtreeBuilding: {
          subtreeCount: subtrees.length,
          totalPlanNodes,
          totalContextNodes,
          subtrees: subtrees.map((subtree, index) => ({
            index,
            planNodeCount: subtree.planNodes.length,
            contextNodeCount: subtree.nodes.filter(
              (n) => n.nodeType === "CONTEXT",
            ).length,
            maxDepth: Math.max(...subtree.nodes.map((n) => n.depth), 0),
            estimatedTokens: subtree.nodes.reduce(
              (sum, n) => sum + n.comment.body.length,
              0,
            ),
            nodes: subtree.nodes.map((node) => ({
              commentId: node.comment.id,
              externalId: node.comment.externalId,
              author: node.comment.authorName ?? "[unknown]",
              nodeType: node.nodeType,
              depth: node.depth,
              bodyPreview: node.comment.body.slice(0, 140),
            })),
          })),
          config: {
            softBudget: config.analysisBuilder.softBudget,
            hardBudget: config.analysisBuilder.hardBudget,
            maxPlanNodes: config.analysisBuilder.maxPlanNodes,
            maxDepth: config.analysisBuilder.maxDepth,
          },
        },
      },
    });
  }

  private async recordLabelingTraces(
    threadId: string,
    subtreeIndex: number,
    traceCalls: LabelingTraceCall[],
  ): Promise<void> {
    for (const call of traceCalls) {
      await this.debugTrace.record({
        threadId,
        batchId: call.batchId,
        step: "quote_labeling",
        statusBefore: "EXTRACTED",
        statusAfter: "LABELED",
        durationMs: call.durationMs,
        model: call.model,
        promptTokens: call.promptTokens,
        completionTokens: call.completionTokens,
        cachedTokens: call.cachedTokens,
        cost: call.cost,
        costLabel: "quote_labeling",
        data: {
          summary: `Quote labeling for subtree ${subtreeIndex + 1}: ${call.productLabelsCount} products, ${call.quoteLabelsCount} quotes labeled`,
          labeling: {
            subtreeIndex,
            productLabelsCount: call.productLabelsCount,
            quoteLabelsCount: call.quoteLabelsCount,
          },
        },
      });
    }
  }

  private async recordSubtreeExtractionTraces(
    threadId: string,
    subtree: Subtree,
    context: ThreadContext,
    subtreeIndex: number,
    statusBefore: Map<string, CommentStatus>,
    traceCalls: ExtractionTraceCall[],
  ): Promise<void> {
    for (const call of traceCalls) {
      const commentNodes = call.planNodes;
      if (commentNodes.length === 0) continue;

      const anchorCommentId = commentNodes[0].comment.id;
      const costByComment = this.proportionalCostByComment(
        commentNodes,
        call.cost,
      );

      for (let i = 0; i < commentNodes.length; i++) {
        const node = commentNodes[i];
        const comment = node.comment;
        const isAnchor = i === 0;
        const validatedEntry = call.validated.find(
          (v) => v.comment.id === comment.id,
        );

        await this.debugTrace.record({
          threadId,
          commentId: comment.id,
          batchId: call.batchId,
          step: "reference_extraction",
          statusBefore: statusBefore.get(comment.id) ?? "NEW",
          statusAfter: comment.status,
          durationMs: isAnchor ? call.durationMs : 0,
          model: isAnchor ? call.model : undefined,
          promptTokens: isAnchor ? call.promptTokens : undefined,
          completionTokens: isAnchor ? call.completionTokens : undefined,
          cachedTokens: isAnchor ? call.cachedTokens : undefined,
          cost: costByComment.get(comment.id) ?? 0,
          costLabel: call.retried
            ? "subtree_extraction_retry"
            : "subtree_extraction",
          data: {
            summary: `Subtree extraction for comment ${comment.externalId}`,
            extraction: {
              subtreeIndex,
              batchId: call.batchId,
              isAnchor,
              batchAnchorCommentId: anchorCommentId,
              planNodeCount: call.planNodes.length,
              contextNodeCount: subtree.nodes.length - subtree.planNodes.length,
              missRate: call.missRate,
              retried: call.retried,
              cheatSheetChars: call.cheatSheetChars,
              cheatSheetProducts: call.cheatSheetProducts,
              extractedProducts:
                validatedEntry?.products.map((product) => {
                  const ref = (comment.productReferences ?? [])[
                    product.productIndex
                  ];
                  const brand = ref?.context?.identification?.brand ?? "";
                  const model = ref?.context?.identification?.model ?? "";
                  return {
                    displayName:
                      getPrimaryModel(ref)?.displayName ??
                      `${brand} ${model}`.trim(),
                    productIndex: product.productIndex,
                    quotes: (product.quotes ?? []).map((quote) => quote.text),
                    sentiment: product.overallSentiment,
                  };
                }) ?? [],
              referencesCreated:
                (comment.productReferences ?? []).map((ref) => ({
                  id: ref.id,
                  relevance: ref.relevance ?? 0,
                  enabled: ref.enabled,
                })) ?? [],
            },
            batch: isAnchor
              ? {
                  planNodeCount: call.planNodes.length,
                  contextNodeCount:
                    subtree.nodes.length - subtree.planNodes.length,
                  model: call.model,
                  missRate: call.missRate,
                  retried: call.retried,
                  totalCost: call.cost,
                  cheatSheetChars: call.cheatSheetChars,
                  cheatSheetProducts: call.cheatSheetProducts,
                }
              : undefined,
            llm: isAnchor
              ? {
                  systemPrompt: call.systemPrompt,
                  userPrompt: call.userPrompt,
                  rawResponse: call.rawResponse,
                  parsedResponse: call.parsedResponse,
                  temperature: 1,
                  schema: "EXTRACTION_JSON_SCHEMA",
                  cachedTokens: call.cachedTokens,
                }
              : undefined,
          },
        });
      }
    }
  }

  private async recordRegistryUpdateTrace(
    threadId: string,
    subtreeIndex: number,
    registrySizeBefore: number,
    context: ThreadContext,
    registryHits: number,
    webSearches: number,
  ): Promise<void> {
    const totalProducts = context.productRegistry.size;
    const productsAdded = Math.max(0, totalProducts - registrySizeBefore);

    await this.debugTrace.record({
      threadId,
      step: "registry_update",
      statusBefore: "N/A",
      statusAfter: "N/A",
      durationMs: 0,
      cost: 0,
      data: {
        summary: `Registry updated (+${productsAdded}, total ${totalProducts}, ${registryHits} hits, ${webSearches} web searches)`,
        registryUpdate: {
          subtreeIndex,
          productsAdded,
          totalProducts,
          registryHits,
          webSearches,
          cheatSheetChars: context.cheatSheetString?.length ?? 0,
        },
      },
    });
  }

  private async recordOpSummarizationTrace(
    threadId: string,
    originalBody: string,
    summary: string,
    wasSummarized: boolean,
    model: string,
    traceData: ChatTraceData | undefined,
  ): Promise<void> {
    try {
      if (!this.dynamicConfig.debug?.traceEnabled) return;

      await this.debugTrace.record({
        threadId,
        step: "op_summarization",
        statusBefore: "N/A",
        statusAfter: "N/A",
        durationMs: traceData?.durationMs ?? 0,
        model: wasSummarized ? model : undefined,
        promptTokens: traceData?.usage.promptTokens,
        completionTokens: traceData?.usage.completionTokens,
        cachedTokens: traceData?.usage.cachedTokens,
        cost: traceData?.cost ?? 0,
        costLabel: wasSummarized ? "op_summarization" : undefined,
        data: {
          summary: wasSummarized
            ? `OP summarized: ${originalBody.length} → ${summary.length} chars`
            : `OP summarization skipped (already summarized, ${summary.length} chars)`,
          opSummarization: {
            originalLength: originalBody.length,
            summaryLength: summary.length,
            action: wasSummarized ? "summarized" : "skipped",
            model,
          },
          llm: traceData
            ? {
                systemPrompt: traceData.messages.find(
                  (m) => m.role === "system",
                )?.content,
                userPrompt:
                  traceData.messages.find((m) => m.role === "user")?.content ??
                  "",
                rawResponse: traceData.rawResponse,
                temperature: traceData.temperature,
                cachedTokens: traceData.usage.cachedTokens,
              }
            : undefined,
        },
      });
    } catch (error) {
      this.logger.warn("Failed to record OP summarization trace", { error });
    }
  }

  private async recordRelevanceTrace(
    threadId: string,
    commentId: string,
    score: number,
    threshold: number,
    status: CommentStatus,
    refs: Array<{
      refId: string;
      score: number;
      factors: import("@ebike-backend/database").RelevanceFactors;
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
    }>,
  ): Promise<void> {
    try {
      if (!this.dynamicConfig.debug?.traceEnabled) return;

      const passed =
        status === CommentStatus.APPROVED ||
        status === CommentStatus.RELEVANCE_CALCULATED;

      await this.debugTrace.record({
        threadId,
        commentId,
        step: "relevance_scoring",
        statusBefore: CommentStatus.EXTRACTED,
        statusAfter: status,
        durationMs: 0,
        cost: 0,
        data: {
          summary: `Relevance score ${score}/${threshold} → ${passed ? "passed" : "skipped"}`,
          relevance: {
            score,
            threshold,
            passed,
            refs: refs.map((r) => ({
              refId: r.refId,
              score: r.score,
              factors: r.factors,
              inputs: r.inputs,
              contentScore: r.contentScore,
              enabled: r.enabled,
            })),
          },
        },
      });
    } catch (error) {
      this.logger.warn("Failed to record relevance trace", { error });
    }
  }

  private proportionalCostByComment(
    nodes: Array<{ comment: UserComment }>,
    totalCost: number,
  ): Map<string, number> {
    return this.proportionalCostByComments(
      nodes.map((node) => node.comment),
      totalCost,
    );
  }

  private proportionalCostByComments(
    comments: UserComment[],
    totalCost: number,
  ): Map<string, number> {
    const lengths = comments.map((comment) => ({
      id: comment.id,
      length: Math.max(1, comment.body.length),
    }));
    const totalLength = sumBy(lengths, "length");
    const result = new Map<string, number>();

    for (const item of lengths) {
      result.set(item.id, totalCost * (item.length / totalLength));
    }

    return result;
  }
}

// ─── Standalone Helpers ──────────────────────────────────────────────────────
