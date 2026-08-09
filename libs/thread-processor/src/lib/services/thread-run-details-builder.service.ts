import { Injectable } from "@nestjs/common";
import {
  CommentStatus,
  ProductReference,
  ProductReferenceRepository,
  ThreadRunDetails,
  ThreadRunStepStats,
  UserCommentRepository,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { ThreadRunStats } from "@ebike-backend/debug";
import { nameOf } from "@ebike-backend/utils";
import { ThreadProcessResult } from "./subtree-processor.service";

interface CommentStatusCount {
  status: CommentStatus;
  count: number;
}

interface ReferenceAggregateRow {
  total: string;
  enabled: string;
  resolved: string;
  deferred: string;
  distinctResolved: string;
  intentSum: string;
  /** Count of ref-level use-case evidence entries (Evidence[] JSONB). */
  useCaseSum: string;
  /** Count of ref-level feature evidence entries (Evidence[] JSONB). */
  featureSum: string;
  quoteSum: string;
}

interface ValidationDecisionCount {
  decision: "approved" | "in_review" | "deleted" | null;
  count: number;
}

interface QuoteEvidence {
  label?: string;
}

interface QuoteShape {
  features?: QuoteEvidence[];
  useCases?: QuoteEvidence[];
  issues?: QuoteEvidence[];
}

interface RefQuotesRow {
  quotes: QuoteShape[] | null;
}

interface RefIssueRow {
  context: { issues?: Array<{ status?: string; type?: string }> } | null;
}

const RESOLUTION_LABELS = new Set([
  "web_search_extraction",
  "cross_market_ranking",
  "web_research_extraction",
  "llm_disambiguation",
  "contextual_resolution",
]);

const EXTRACTION_LABELS = new Set([
  "subtree_extraction",
  "subtree_extraction_retry",
]);

const IDENTIFICATION_LABELS = new Set([
  "product_identification",
  "subtree_identification",
]);

export interface BuildDetailsInput {
  threadId: string;
  processResult?: ThreadProcessResult;
  stats: ThreadRunStats;
}

@Injectable()
export class ThreadRunDetailsBuilderService {
  private readonly logger = new CustomLogger(
    ThreadRunDetailsBuilderService.name,
  );

  constructor(
    private readonly userCommentRepository: UserCommentRepository,
    private readonly productReferenceRepository: ProductReferenceRepository,
  ) {}

  async build(input: BuildDetailsInput): Promise<ThreadRunDetails> {
    const { threadId, processResult, stats } = input;

    const [
      commentCounts,
      validationDecisions,
      referenceAggregate,
      issueAggregate,
      validationIssueAggregate,
    ] = await Promise.all([
      this.fetchCommentStatusCounts(threadId),
      this.fetchValidationDecisionCounts(threadId),
      this.fetchReferenceAggregate(threadId),
      this.fetchIssueAggregate(threadId),
      this.fetchValidationIssueAggregate(threadId),
    ]);

    const thread = this.buildThreadCounts(
      commentCounts,
      processResult?.subtreeCount ?? 0,
    );

    const steps = this.buildSteps({
      stats,
      processResult,
      referenceAggregate,
      issueAggregate,
      validationDecisions,
      validationIssueAggregate,
    });

    const totalLlmCallCount = stats.modelsUsed.reduce(
      (sum, entry) => sum + entry.callCount,
      0,
    );

    return {
      thread,
      steps,
      models: {
        totalLlmCallCount,
        usage: stats.modelsUsed.map((entry) => ({ ...entry })),
      },
    };
  }

  // ─── Aggregations ──────────────────────────────────────────────────────────

  private async fetchCommentStatusCounts(
    threadId: string,
  ): Promise<CommentStatusCount[]> {
    const rows = await this.userCommentRepository.repo
      .createQueryBuilder("comment")
      .select("comment.status", "status")
      .addSelect("COUNT(*)::int", "count")
      .where('comment."threadId" = :threadId', { threadId })
      .groupBy("comment.status")
      .getRawMany<{ status: CommentStatus; count: number }>();

    return rows.map((row) => ({
      status: row.status,
      count: Number(row.count),
    }));
  }

  private async fetchValidationDecisionCounts(
    threadId: string,
  ): Promise<ValidationDecisionCount[]> {
    const rows = await this.userCommentRepository.repo
      .createQueryBuilder("comment")
      .select('comment."validationDecision"', "decision")
      .addSelect("COUNT(*)::int", "count")
      .where('comment."threadId" = :threadId', { threadId })
      .andWhere('comment."validationDecision" IS NOT NULL')
      .groupBy('comment."validationDecision"')
      .getRawMany<{
        decision: "approved" | "in_review" | "deleted" | null;
        count: number;
      }>();

    return rows.map((row) => ({
      decision: row.decision,
      count: Number(row.count),
    }));
  }

  private async fetchReferenceAggregate(
    threadId: string,
  ): Promise<ReferenceAggregateRow> {
    const row = await this.productReferenceRepository.repo
      .createQueryBuilder("reference")
      .innerJoin(`reference.${nameOf<ProductReference>("comment")}`, "comment")
      .leftJoin(
        `reference.${nameOf<ProductReference>("productCategory")}`,
        "category",
      )
      .where('comment."threadId" = :threadId', { threadId })
      .select("COUNT(*)::int", "total")
      .addSelect(
        "COUNT(*) FILTER (WHERE reference.enabled = true)::int",
        "enabled",
      )
      .addSelect(
        // "Resolved" = the reference has at least one persisted candidate
        // (the isPrimary invariant guarantees one of them is the primary).
        `COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM product_reference_candidate prc WHERE prc."referenceId" = reference.id))::int`,
        "resolved",
      )
      .addSelect(
        // "Deferred" is derived: a reference whose (non-null) category is
        // disabled waits for Resolution Backfill instead of resolving inline.
        `COUNT(*) FILTER (WHERE reference."productCategoryId" IS NOT NULL AND category."extractionEnabled" = false)::int`,
        "deferred",
      )
      .addSelect(
        // Distinct resolved products across this thread's references —
        // counted from the primary candidate's modelId.
        `(SELECT COUNT(DISTINCT prc."modelId")::int
          FROM product_reference_candidate prc
          INNER JOIN product_reference pr ON pr.id = prc."referenceId"
          INNER JOIN user_comment uc ON uc.id = pr."commentId"
          WHERE uc."threadId" = :threadId AND prc."isPrimary" = true)`,
        "distinctResolved",
      )
      .addSelect(
        "COALESCE(SUM(COALESCE(array_length(reference.intents, 1), 0)), 0)::int",
        "intentSum",
      )
      .addSelect(
        'COALESCE(SUM(COALESCE(jsonb_array_length(reference."useCases"), 0)), 0)::int',
        "useCaseSum",
      )
      .addSelect(
        'COALESCE(SUM(COALESCE(jsonb_array_length(reference."features"), 0)), 0)::int',
        "featureSum",
      )
      .addSelect(
        "COALESCE(SUM(COALESCE(jsonb_array_length(reference.quotes), 0)), 0)::int",
        "quoteSum",
      )
      .getRawOne<ReferenceAggregateRow>();

    return (
      row ?? {
        total: "0",
        enabled: "0",
        resolved: "0",
        deferred: "0",
        distinctResolved: "0",
        intentSum: "0",
        useCaseSum: "0",
        featureSum: "0",
        quoteSum: "0",
      }
    );
  }

  /**
   * Streams quote arrays from references on this thread and counts issue
   * evidence. An issue evidence is an entry on `quote.issues[]`, where the
   * label is a closed-list issue type from the category vocabulary.
   */
  private async fetchIssueAggregate(threadId: string): Promise<{
    issueCount: number;
    issuesByType: Record<string, number>;
  }> {
    const rows = await this.productReferenceRepository.repo
      .createQueryBuilder("reference")
      .innerJoin(`reference.${nameOf<ProductReference>("comment")}`, "comment")
      .where('comment."threadId" = :threadId', { threadId })
      .andWhere("reference.quotes IS NOT NULL")
      .select("reference.quotes", "quotes")
      .getRawMany<RefQuotesRow>();

    let issueCount = 0;
    const issuesByType: Record<string, number> = {};

    for (const row of rows) {
      const quotes = row.quotes;
      if (!Array.isArray(quotes)) continue;
      for (const quote of quotes) {
        const issues = quote?.issues;
        if (!Array.isArray(issues)) continue;
        for (const evidence of issues) {
          if (!evidence?.label) continue;
          issueCount += 1;
          const key = evidence.label;
          issuesByType[key] = (issuesByType[key] ?? 0) + 1;
        }
      }
    }

    return { issueCount, issuesByType };
  }

  /**
   * Streams ProductReference.context.issues[] from references on this thread
   * and counts validation issues. An issue is "unresolved" if its status is
   * anything other than 'resolved' (i.e. 'pending' | 'unresolved' | 'unresolvable').
   */
  private async fetchValidationIssueAggregate(threadId: string): Promise<{
    issueCount: number;
    unresolvedIssueCount: number;
  }> {
    const rows = await this.productReferenceRepository.repo
      .createQueryBuilder("reference")
      .innerJoin(`reference.${nameOf<ProductReference>("comment")}`, "comment")
      .where('comment."threadId" = :threadId', { threadId })
      .andWhere(`reference.context -> 'issues' IS NOT NULL`)
      .select("reference.context", "context")
      .getRawMany<RefIssueRow>();

    let issueCount = 0;
    let unresolvedIssueCount = 0;

    for (const row of rows) {
      const issues = row.context?.issues;
      if (!Array.isArray(issues)) continue;
      for (const issue of issues) {
        issueCount += 1;
        if (issue?.status !== "resolved") {
          unresolvedIssueCount += 1;
        }
      }
    }

    return { issueCount, unresolvedIssueCount };
  }

  // ─── Builders ──────────────────────────────────────────────────────────────

  private buildThreadCounts(
    commentCounts: CommentStatusCount[],
    subtreeCount: number,
  ): ThreadRunDetails["thread"] {
    const byStatus = new Map(commentCounts.map((c) => [c.status, c.count]));
    const total = commentCounts.reduce((sum, c) => sum + c.count, 0);
    const newCount = byStatus.get(CommentStatus.NEW) ?? 0;
    const skipped = byStatus.get(CommentStatus.SKIPPED) ?? 0;
    const identified = this.sumStatuses(byStatus, [
      CommentStatus.IDENTIFIED,
      CommentStatus.EXTRACTED,
      CommentStatus.LABELED,
      CommentStatus.VALIDATED,
      CommentStatus.RELEVANCE_CALCULATED,
      CommentStatus.IN_REVIEW,
      CommentStatus.APPROVED,
      CommentStatus.DELETED,
    ]);

    return {
      commentCount: total,
      commentsProcessed: total - newCount,
      commentsSkipped: skipped,
      commentsIdentified: identified,
      subtreeCount,
    };
  }

  private buildSteps(args: {
    stats: ThreadRunStats;
    processResult?: ThreadProcessResult;
    referenceAggregate: ReferenceAggregateRow;
    issueAggregate: {
      issueCount: number;
      issuesByType: Record<string, number>;
    };
    validationDecisions: ValidationDecisionCount[];
    validationIssueAggregate: {
      issueCount: number;
      unresolvedIssueCount: number;
    };
  }): ThreadRunDetails["steps"] {
    const {
      stats,
      processResult,
      referenceAggregate,
      issueAggregate,
      validationDecisions,
      validationIssueAggregate,
    } = args;

    const buckets = this.bucketStatsByCategory(stats);

    const decisionCounts = this.buildDecisionCounts(validationDecisions);

    return {
      opSummarization: {
        ...buckets.opSummarization,
        summarized: processResult?.opSummarized ?? false,
      },
      productIdentification: {
        ...buckets.productIdentification,
        mentionsIdentified: processResult?.productMentionsIdentified ?? 0,
      },
      extraction: {
        ...buckets.extraction,
        quoteCount: this.toInt(referenceAggregate.quoteSum),
        intentLabelsApplied: this.toInt(referenceAggregate.intentSum),
      },
      labeling: {
        ...buckets.labeling,
        featureLabelsApplied: this.toInt(referenceAggregate.featureSum),
        useCaseLabelsApplied: this.toInt(referenceAggregate.useCaseSum),
        issueCount: issueAggregate.issueCount,
        issuesByType:
          Object.keys(issueAggregate.issuesByType).length > 0
            ? issueAggregate.issuesByType
            : undefined,
      },
      productResolution: {
        ...buckets.productResolution,
        productReferenceCount: this.toInt(referenceAggregate.total),
        productReferencesEnabled: this.toInt(referenceAggregate.enabled),
        productReferencesResolved: this.toInt(referenceAggregate.resolved),
        productReferencesDeferred: this.toInt(referenceAggregate.deferred),
        distinctProductsResolved: this.toInt(
          referenceAggregate.distinctResolved,
        ),
        distinctProductsInRegistry:
          processResult?.distinctProductsInRegistry ?? 0,
      },
      validation: {
        ...buckets.validation,
        decisions: decisionCounts,
        issueCount: validationIssueAggregate.issueCount,
        unresolvedIssueCount: validationIssueAggregate.unresolvedIssueCount,
      },
      relevance: buckets.relevance,
      imageAnalysis: buckets.imageAnalysis,
      translation: buckets.translation,
      other: buckets.other,
    };
  }

  private bucketStatsByCategory(stats: ThreadRunStats): {
    opSummarization: ThreadRunStepStats;
    productIdentification: ThreadRunStepStats;
    extraction: ThreadRunStepStats;
    labeling: ThreadRunStepStats;
    productResolution: ThreadRunStepStats;
    validation: ThreadRunStepStats;
    relevance: ThreadRunStepStats;
    imageAnalysis: ThreadRunStepStats;
    translation: ThreadRunStepStats;
    other: ThreadRunStepStats;
  } {
    const opSummarization = this.emptyStep();
    const productIdentification = this.emptyStep();
    const extraction = this.emptyStep();
    const labeling = this.emptyStep();
    const productResolution = this.emptyStep();
    const validation = this.emptyStep();
    const relevance = this.emptyStep();
    const imageAnalysis = this.emptyStep();
    const translation = this.emptyStep();
    const other = this.emptyStep();

    for (const [label, stat] of Object.entries(stats.costByLabel)) {
      // Generic retry detection: a `${label}_retry` suffix means "this call
      // is a retry of the corresponding step". Route the cost/calls into
      // that step's bucket and record a separate retryCount.
      const isRetry = label.endsWith("_retry");
      const baseLabel = isRetry ? label.slice(0, -"_retry".length) : label;

      const target = this.routeLabel(baseLabel, {
        opSummarization,
        productIdentification,
        extraction,
        labeling,
        productResolution,
        validation,
        relevance,
        imageAnalysis,
        translation,
        other,
      });

      target.costUsd += stat.costUsd;
      target.llmCallCount += stat.llmCallCount;
      target.promptTokens += stat.promptTokens;
      target.completionTokens += stat.completionTokens;
      target.cachedTokens += stat.cachedTokens;

      if (isRetry) {
        target.retryCount += stat.llmCallCount;
      }
    }

    return {
      opSummarization,
      productIdentification,
      extraction,
      labeling,
      productResolution,
      validation,
      relevance,
      imageAnalysis,
      translation,
      other,
    };
  }

  private routeLabel(
    label: string,
    targets: {
      opSummarization: ThreadRunStepStats;
      productIdentification: ThreadRunStepStats;
      extraction: ThreadRunStepStats;
      labeling: ThreadRunStepStats;
      productResolution: ThreadRunStepStats;
      validation: ThreadRunStepStats;
      relevance: ThreadRunStepStats;
      imageAnalysis: ThreadRunStepStats;
      translation: ThreadRunStepStats;
      other: ThreadRunStepStats;
    },
  ): ThreadRunStepStats {
    if (label === "op_summarization") return targets.opSummarization;
    if (IDENTIFICATION_LABELS.has(label)) return targets.productIdentification;
    if (EXTRACTION_LABELS.has(label)) return targets.extraction;
    if (label === "quote_labeling") return targets.labeling;
    if (RESOLUTION_LABELS.has(label)) return targets.productResolution;
    if (label === "llm_validation") return targets.validation;
    if (label === "relevance_calculation") return targets.relevance;
    if (label === "image_analysis") return targets.imageAnalysis;
    if (label === "translation") return targets.translation;

    this.logger.debug(`Unknown costLabel bucketed into 'other'`, { label });
    return targets.other;
  }

  private buildDecisionCounts(rows: ValidationDecisionCount[]): {
    approved: number;
    inReview: number;
    deleted: number;
  } {
    const result = { approved: 0, inReview: 0, deleted: 0 };
    for (const row of rows) {
      if (row.decision === "approved") result.approved = row.count;
      else if (row.decision === "in_review") result.inReview = row.count;
      else if (row.decision === "deleted") result.deleted = row.count;
    }
    return result;
  }

  private sumStatuses(
    byStatus: Map<CommentStatus, number>,
    statuses: CommentStatus[],
  ): number {
    return statuses.reduce(
      (sum, status) => sum + (byStatus.get(status) ?? 0),
      0,
    );
  }

  private emptyStep(): ThreadRunStepStats {
    return {
      costUsd: 0,
      llmCallCount: 0,
      retryCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
    };
  }

  private toInt(value: string | number | null | undefined): number {
    if (value == null) return 0;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
  }
}
