import { Injectable } from "@nestjs/common";
import {
  ProductCategory,
  ProductCategoryRepository,
  RelevanceCriteriaRatings,
  RelevanceRating,
  RelevanceResult,
  RelevanceScoreBreakdown,
  Thread,
  ThreadProductCategory,
  ThreadRepository,
  ThreadStatus,
} from "@ebike-backend/database";
import { AiChatService } from "@ebike-backend/ai";
import { CategoryConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import { DebugTraceService } from "@ebike-backend/debug";
import { isUserComment, RedditThreadService } from "@ebike-backend/reddit";
import { ThreadMetricsService } from "@ebike-backend/metrics";
import { compact, isEmpty } from "lodash";
import { CategoryContentRelevanceScorerService } from "../services/category-content-relevance-scorer.service";

export interface SampledComment {
  id: string;
  body: string;
  ups: number;
  isTopLevel: boolean;
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

export interface ThreadSelectionServiceConfig {
  commentFetchLimit: number;
  commentSampleSize: number;
  minWeightedScore: number;
  model: string;
  thinking?: boolean;
  effort?: string;
  compositeScoring: CompositeScoringConfig;
  candidatePoolSize: number;
  minCategoryRelevance: number;
  maxCategoriesPerThread: number;
}

export interface SelectionResult {
  outcome: "selected" | "llm_low_relevance" | "llm_no_category";
  criteria: RelevanceCriteriaRatings;
  weightedScore: number;
  breakdown: RelevanceScoreBreakdown;
  categories: Array<{ slug: string; name: string; relevance: number }>;
  sampledComments: SampledComment[];
  /**
   * Criteria from HARD_GATE_CRITERIA that came back 'low'. Empty when the
   * hard gate passed. Set even on 'selected' / 'llm_no_category' outcomes
   * so the debug modal can surface the per-criterion verdict consistently.
   */
  hardGateFailedCriteria: Array<keyof RelevanceCriteriaRatings>;
}

const RATING_VALUES: Record<RelevanceRating, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const CRITERIA_WEIGHTS: Record<keyof RelevanceCriteriaRatings, number> = {
  experienceDensity: 0.25,
  productSpecificity: 0.25,
  featureDiscussion: 0.15,
  buyerResearchValue: 0.2,
  comparativeContent: 0.15,
};

/**
 * Criteria that must be at least 'medium' for a thread to be SELECTED.
 * Composite score alone is not enough — a thread can score above
 * minWeightedScore via featureDiscussion/comparativeContent while still
 * being useless for review extraction (e.g. spec talk with no owners,
 * vague brand-name dropping, no purchase angle). These three criteria
 * directly gate whether the thread can produce usable ProductReferences:
 *   - experienceDensity: someone has to have actually used the product
 *   - productSpecificity: a specific product has to be identifiable
 *   - buyerResearchValue: the discussion has to be about buying/owning,
 *     not adjacent topics (software, mods, games) on category hardware
 * If any of these is 'low', skip extraction regardless of composite score.
 */
const HARD_GATE_CRITERIA: Array<keyof RelevanceCriteriaRatings> = [
  "experienceDensity",
  "productSpecificity",
  "buyerResearchValue",
];

const VALID_RATINGS = new Set<RelevanceRating>(["low", "medium", "high"]);

const SELECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          slug: { type: "string" },
          relevance: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["slug", "relevance"],
      },
    },
    criteria: {
      type: "object",
      additionalProperties: false,
      properties: {
        experienceDensity: { type: "string", enum: ["low", "medium", "high"] },
        productSpecificity: { type: "string", enum: ["low", "medium", "high"] },
        featureDiscussion: { type: "string", enum: ["low", "medium", "high"] },
        buyerResearchValue: { type: "string", enum: ["low", "medium", "high"] },
        comparativeContent: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: [
        "experienceDensity",
        "productSpecificity",
        "featureDiscussion",
        "buyerResearchValue",
        "comparativeContent",
      ],
    },
  },
  required: ["categories", "criteria"],
} as const;

const SYSTEM_PROMPT = `You are evaluating a Reddit thread to determine:
  (a) which product categories the thread is actually about, and
  (b) whether the thread contains enough genuine product experience to be
      worth processing for review extraction.

You will be given a list of candidate categories. For each candidate, rate
how strongly the thread is about that category on a 1-100 scale:
  - 1-20  = mentioned only incidentally / barely related
  - 30-50 = touches the category but not the focus
  - 60-80 = clearly about this category
  - 90+   = the thread's primary focus

A thread is "about" category X only when products in X are themselves being
discussed, evaluated, or compared. When category products are merely the
medium for something else (e.g. games or media displayed on monitors/TVs,
photos taken with a phone, audio played through headsets, software running
on a laptop), cap category relevance at 40 — the category is touched but
not the focus, even if its products are named repeatedly. The subject of
the thread, not the platform it runs on, drives the score.

Then rate the thread's research value using 5 criteria, with respect to
whichever categories scored 50+. If no category scored 50+, rate every
criterion as "low".

Focus on the thread's primary purpose. Threads whose purpose is something
other than discussing or evaluating category products — giveaways, contests,
wish lists, dream builds, build showcases, tech support for unrelated issues,
memes, news, hype — score low on all criteria even when category products
are frequently named.

1. experienceDensity — how much of the discussion comes from people who own,
   have used, or have tested products in the matched categories.
   - high: multiple commenters describe personal ownership or hands-on testing
   - medium: a few share experience but most are asking or speculating
   - low: aspirational, hypothetical, or about products outside the categories

2. productSpecificity — are specific products IN THE MATCHED CATEGORIES
   (brand + model) substantively discussed, not just mentioned in passing.
   Games, mods, software, services, accessories, and any other adjacent
   products do NOT count — only products that would belong in one of the
   candidate categories above.
   - high: multiple specific products in the matched categories named with
     model numbers and evaluated
   - medium: category brand names mentioned but models vague, or only 1-2
     category products
   - low: generic discussion, no identifiable category products, or only
     incidental mentions; OR specific products are named but none of them
     belong to the matched categories

3. featureDiscussion — are specific features/attributes discussed beyond vague
   sentiment.
   - high: concrete feature discussion (curve radius, G-sync, HDR, glare, battery life)
   - medium: some features mentioned without depth ("colors are great")
   - low: only vague sentiment ("amazing", "looks cool") or spec recitation

4. buyerResearchValue — how useful this thread is for someone researching a
   purchase of a category product. The buying guidance must be about
   products in the matched categories — not about software, mods, games,
   services, or other adjacent things that happen to be discussed.
   - high: actionable buying guidance for category products — pros/cons,
     value, use-case fit on specific models
   - medium: some useful signals for category products mixed with noise —
     partial recommendations
   - low: no buying guidance for category products — debate, memes,
     off-topic, wrong category, or guidance only about adjacent things
     (software/mods/games)

5. comparativeContent — does the thread directly compare category products
   against each other (one of the highest-value patterns for extraction).
   Comparisons of adjacent things (software vs software, mod vs mod,
   game vs game) do not count.
   - high: multiple direct comparisons between category products ("X vs Y",
     "switched from X to Y", side-by-side)
   - medium: at least one substantive comparison between category products,
     or several brief comparative mentions
   - low: no comparisons of category products; products only discussed in
     isolation, or only adjacent things are compared

Hard implication: if productSpecificity is "low", then buyerResearchValue
and comparativeContent MUST also be "low". You cannot research a purchase
or compare products meaningfully without specific products being named.

Return a JSON object with EXACTLY these two top-level keys (no others, no
renames, no synonyms):
  - "categories": array of objects, each {"slug": "<one of the candidate
    slugs above, verbatim>", "relevance": <integer 1-100>}. Include every
    candidate category exactly once. Do NOT use a map keyed by slug.
  - "criteria": object with these five keys (exact names), each set to
    "low" | "medium" | "high": experienceDensity, productSpecificity,
    featureDiscussion, buyerResearchValue, comparativeContent.

Example output shape (high-relevance thread — OP comparing two specific
keyboards they own):
{
  "categories": [
    {"slug": "keyboards", "relevance": 92},
    {"slug": "mice", "relevance": 15}
  ],
  "criteria": {
    "experienceDensity": "high",
    "productSpecificity": "high",
    "featureDiscussion": "high",
    "buyerResearchValue": "high",
    "comparativeContent": "high"
  }
}

Example output shape (medium-relevance thread — headphones briefly
recommended in a thread mostly about something else):
{
  "categories": [
    {"slug": "headphones", "relevance": 60},
    {"slug": "speakers", "relevance": 25}
  ],
  "criteria": {
    "experienceDensity": "medium",
    "productSpecificity": "medium",
    "featureDiscussion": "medium",
    "buyerResearchValue": "medium",
    "comparativeContent": "low"
  }
}`;

const TOP_LEVEL_COMMENT_LIMIT = 25;

@Injectable()
export class ThreadSelectionService {
  private readonly logger = new CustomLogger(ThreadSelectionService.name);

  constructor(
    private readonly aiChatService: AiChatService,
    private readonly redditThreadService: RedditThreadService,
    private readonly debugTrace: DebugTraceService,
    private readonly threadRepository: ThreadRepository,
    private readonly threadMetrics: ThreadMetricsService,
    private readonly categoryRepository: ProductCategoryRepository,
    private readonly categoryScorer: CategoryContentRelevanceScorerService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  /**
   * Run the full LLM selection pipeline for a thread and persist the result
   * (status, categories, relevance). See `runSelection` for the underlying
   * computation; this wrapper just saves and emits a trace.
   */
  public async select(
    thread: Thread,
    config: ThreadSelectionServiceConfig,
  ): Promise<SelectionResult> {
    return this.runSelection(thread, config, { persist: true });
  }

  /**
   * Dry-run variant for debug tooling: runs the same Stage 2 pipeline but
   * does NOT persist the Thread row or emit a processing trace. The Thread
   * argument can be an unsaved in-memory instance — only `externalId`,
   * `topic`, and (optionally) `threadCreatedAt` are required.
   */
  public async previewSelection(
    thread: Thread,
    config: ThreadSelectionServiceConfig,
  ): Promise<SelectionResult> {
    return this.runSelection(thread, config, { persist: false });
  }

  /**
   * Core Stage 2 pipeline:
   *   1. Fetch comments
   *   2. Build candidate categories via the cheap term scorer (+ subreddit boost)
   *   3. ONE LLM call → category relevance scores + 5 criteria ratings
   *   4. Filter categories by minCategoryRelevance, cap at maxCategoriesPerThread
   *   5. Compute composite score from criteria + recency + comment-count multiplier
   *   6. (when persist=true) Persist categories, relevance, relevanceResult, status
   */
  private async runSelection(
    thread: Thread,
    config: ThreadSelectionServiceConfig,
    opts: { persist: boolean },
  ): Promise<SelectionResult> {
    const startTime = Date.now();

    const { comments, totalCommentCount } = await this.fetchComments(
      thread.externalId,
      config.commentFetchLimit,
    );
    if (totalCommentCount !== undefined) {
      thread.commentCount = totalCommentCount;
    }

    const sampledComments = this.sampleComments(
      comments,
      config.commentSampleSize,
    );
    if (isEmpty(sampledComments)) {
      throw new Error(
        `No comments fetched for thread ${thread.id} (${thread.externalId}) — cannot run selection`,
      );
    }

    const candidates = await this.pickCandidateCategories(
      thread,
      sampledComments,
      config.candidatePoolSize,
    );

    const llmOutput = await this.callLlm(thread, sampledComments, candidates, {
      model: config.model,
      thinking: config.thinking,
      effort: config.effort,
    });

    const allCandidateCategories = new Map(candidates.map((c) => [c.slug, c]));
    const acceptedCategories = llmOutput.categories
      .filter((entry) => entry.relevance >= config.minCategoryRelevance)
      .map((entry) => ({
        entry,
        category: allCandidateCategories.get(entry.slug),
      }))
      .filter(
        (
          item,
        ): item is {
          entry: (typeof llmOutput.categories)[0];
          category: ProductCategory;
        } => item.category !== undefined,
      )
      .sort((a, b) => b.entry.relevance - a.entry.relevance)
      .slice(0, config.maxCategoriesPerThread);

    const llmScore = this.computeWeightedScore(llmOutput.criteria);
    const { compositeScore, breakdown } = this.computeCompositeScore(
      llmScore,
      thread,
      config.compositeScoring,
    );

    thread.relevance = compositeScore;
    thread.relevanceResult = {
      criteria: llmOutput.criteria,
      weightedScore: compositeScore,
      breakdown,
    };

    const hardGateFailedCriteria = HARD_GATE_CRITERIA.filter(
      (key) => llmOutput.criteria[key] === "low",
    );

    let outcome: SelectionResult["outcome"];
    if (acceptedCategories.length === 0) {
      thread.status = ThreadStatus.LLM_NO_CATEGORY;
      thread.categories = [];
      outcome = "llm_no_category";
    } else if (hardGateFailedCriteria.length > 0) {
      thread.status = ThreadStatus.LLM_LOW_RELEVANCE;
      thread.categories = this.buildCategoryRows(thread, acceptedCategories);
      outcome = "llm_low_relevance";
    } else if (compositeScore < config.minWeightedScore) {
      thread.status = ThreadStatus.LLM_LOW_RELEVANCE;
      thread.categories = this.buildCategoryRows(thread, acceptedCategories);
      outcome = "llm_low_relevance";
    } else {
      thread.status = ThreadStatus.SELECTED;
      thread.categories = this.buildCategoryRows(thread, acceptedCategories);
      outcome = "selected";
    }

    if (opts.persist) {
      await this.threadRepository.save(thread);
    }

    const durationMs = Date.now() - startTime;
    this.threadMetrics.relevanceCalculationDurationObserved(durationMs / 1000);

    const result: SelectionResult = {
      outcome,
      criteria: llmOutput.criteria,
      weightedScore: compositeScore,
      breakdown,
      categories: acceptedCategories.map((item) => ({
        slug: item.category.slug,
        name: item.category.name,
        relevance: item.entry.relevance,
      })),
      sampledComments,
      hardGateFailedCriteria,
    };

    if (opts.persist) {
      await this.recordTrace(
        thread,
        result,
        candidates,
        llmOutput,
        config,
        durationMs,
      );
    }

    this.logger.log("Thread selection completed", {
      threadId: thread.id,
      outcome,
      llmScore,
      compositeScore,
      categoryCount: result.categories.length,
      durationMs,
    });

    return result;
  }

  // ─── Comment Fetch + Sampling ─────────────────────────────────────────────

  private async fetchComments(
    externalId: string,
    commentFetchLimit: number,
  ): Promise<{ comments: any[]; totalCommentCount: number | undefined }> {
    const submission = await this.redditThreadService.getThread(
      externalId,
      commentFetchLimit,
    );
    return {
      comments: submission.comments ?? [],
      totalCommentCount: submission.num_comments,
    };
  }

  private sampleComments(
    allComments: any[],
    sampleSize: number,
  ): SampledComment[] {
    const validComments = this.flattenAndFilter(allComments);
    const seen = new Set<string>();
    const result: SampledComment[] = [];

    const topLevelComments = validComments
      .filter((comment) => comment.isTopLevel)
      .sort((a, b) => b.ups - a.ups);

    const halfSample = Math.ceil(sampleSize / 2);

    for (const comment of topLevelComments) {
      if (result.length >= halfSample) break;
      if (seen.has(comment.id)) continue;
      seen.add(comment.id);
      result.push(comment);
    }

    const allByUpvotes = validComments.sort((a, b) => b.ups - a.ups);
    for (const comment of allByUpvotes) {
      if (result.length >= sampleSize) break;
      if (seen.has(comment.id)) continue;
      seen.add(comment.id);
      result.push(comment);
    }

    return result;
  }

  private flattenAndFilter(comments: any[]): SampledComment[] {
    const result: SampledComment[] = [];
    for (const comment of comments) {
      if (this.isValidComment(comment)) {
        result.push({
          id: comment.id,
          body: comment.body,
          ups: comment.ups ?? 0,
          isTopLevel: true,
        });
      }
      const replies = comment.replies ?? [];
      for (const reply of replies) {
        if (this.isValidComment(reply)) {
          result.push({
            id: reply.id,
            body: reply.body,
            ups: reply.ups ?? 0,
            isTopLevel: false,
          });
        }
      }
    }
    return result;
  }

  private isValidComment(comment: {
    body?: string;
    author?: { name?: string } | string;
  }): boolean {
    return isUserComment(comment);
  }

  // ─── Candidate Categories ─────────────────────────────────────────────────

  private async pickCandidateCategories(
    thread: Thread,
    sampledComments: SampledComment[],
    candidatePoolSize: number,
  ): Promise<ProductCategory[]> {
    const allCategories = await this.categoryRepository.getAll({
      where: { enabled: true },
    });

    const corpus = compact([
      thread.title,
      thread.text,
      ...sampledComments.map((c) => c.body),
    ]);

    if (isEmpty(corpus)) return allCategories;

    const scored = this.categoryScorer.resolveByContent(corpus, allCategories);

    if (thread.topic) {
      for (const result of scored) {
        const catConfig = this.categoryConfigService.getConfig(
          result.category.slug,
        );
        const subredditMatch = catConfig?.subreddits?.find(
          (sub) => sub.name.toLowerCase() === thread.topic.toLowerCase(),
        );
        if (subredditMatch) {
          result.relevance = Math.min(
            100,
            result.relevance + subredditMatch.boost,
          );
        }
      }
      scored.sort((a, b) => b.relevance - a.relevance);
    }

    if (isEmpty(scored)) return allCategories;
    return scored.slice(0, candidatePoolSize).map((result) => result.category);
  }

  // ─── LLM Call ──────────────────────────────────────────────────────────────

  private async callLlm(
    thread: Thread,
    sampledComments: SampledComment[],
    candidates: ProductCategory[],
    llmConfig: { model: string; thinking?: boolean; effort?: string },
  ): Promise<{
    categories: Array<{ slug: string; relevance: number }>;
    criteria: RelevanceCriteriaRatings;
  }> {
    const userPrompt = this.buildUserPrompt(
      thread,
      sampledComments,
      candidates,
    );

    const response = await this.aiChatService.createChat({
      costLabel: "thread_selection",
      schema: SELECTION_SCHEMA,
      schemaName: "thread_selection",
      model: llmConfig.model,
      ...(llmConfig.thinking !== undefined && { thinking: llmConfig.thinking }),
      ...(llmConfig.effort !== undefined && { effort: llmConfig.effort }),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 1,
    });

    const parsed = JSON.parse(response.choices[0].message.content ?? "{}") as {
      categories: Array<{ slug: string; relevance: number }>;
      criteria: RelevanceCriteriaRatings;
    };

    // Validate criteria — coerce invalid values to 'medium'
    for (const key of Object.keys(CRITERIA_WEIGHTS) as Array<
      keyof RelevanceCriteriaRatings
    >) {
      const value = parsed.criteria?.[key];
      if (!VALID_RATINGS.has(value)) {
        if (!parsed.criteria) parsed.criteria = {} as RelevanceCriteriaRatings;
        parsed.criteria[key] = "medium";
      }
    }

    // Drop unknown slugs the LLM may have hallucinated
    const allowedSlugs = new Set(candidates.map((c) => c.slug));
    parsed.categories = (parsed.categories ?? []).filter((c) =>
      allowedSlugs.has(c.slug),
    );

    return parsed;
  }

  private buildUserPrompt(
    thread: Thread,
    sampledComments: SampledComment[],
    candidates: ProductCategory[],
  ): string {
    const commentTexts = sampledComments
      .map((comment) => this.truncateText(comment.body, 300))
      .join("\n---\n");

    const candidateList = candidates
      .map((category) => {
        const aliases = (category.aliases ?? []).join(", ");
        return aliases
          ? `  - ${category.slug} (${category.name}; aliases: ${aliases})`
          : `  - ${category.slug} (${category.name})`;
      })
      .join("\n");

    return `Thread Title: ${thread.title}
Subreddit: ${thread.topic ?? "[unknown]"}
Total Comments: ${thread.commentCount ?? 0}

--- Candidate Categories ---
${candidateList}

--- Thread Content ---
${thread.title}
${thread.text ? this.truncateText(thread.text, 500) : ""}

--- Sample Comments (${sampledComments.length} of ${thread.commentCount ?? 0}) ---
${commentTexts}`;
  }

  // ─── Composite Scoring ─────────────────────────────────────────────────────

  private computeWeightedScore(criteria: RelevanceCriteriaRatings): number {
    let rawScore = 0;
    for (const [key, weight] of Object.entries(CRITERIA_WEIGHTS)) {
      const rating = criteria[key as keyof RelevanceCriteriaRatings];
      rawScore += RATING_VALUES[rating] * weight;
    }
    // Normalize from 1.0-3.0 range to 1-100
    return Math.round(((rawScore - 1) / 2) * 99 + 1);
  }

  private computeCompositeScore(
    llmScore: number,
    thread: Thread,
    config: CompositeScoringConfig,
  ): { compositeScore: number; breakdown: RelevanceScoreBreakdown } {
    const commentCountMultiplier = this.computeCommentCountMultiplier(
      thread.commentCount ?? 0,
      config,
    );
    const recencyFactor = this.computeRecencyFactor(
      thread.threadCreatedAt ?? thread.createdAt ?? new Date(),
      config.recencyHalfLifeDays,
    );

    const raw =
      (config.llmWeight * llmScore + config.recencyWeight * recencyFactor) *
      commentCountMultiplier;

    const compositeScore = Math.round(Math.max(1, Math.min(100, raw)));

    return {
      compositeScore,
      breakdown: {
        llmScore,
        commentCountFactor: Math.round(commentCountMultiplier * 100),
        recencyFactor,
      },
    };
  }

  private computeCommentCountMultiplier(
    commentCount: number,
    config: CompositeScoringConfig,
  ): number {
    if (commentCount < config.veryLowCommentThreshold) {
      return config.veryLowCommentMultiplier;
    }
    if (commentCount < config.lowCommentThreshold) {
      return config.lowCommentMultiplier;
    }
    return 1;
  }

  private computeRecencyFactor(threadDate: Date, halfLifeDays: number): number {
    const ageDays =
      (Date.now() - new Date(threadDate).getTime()) / (1000 * 60 * 60 * 24);
    const factor = Math.pow(2, -ageDays / halfLifeDays);
    return Math.round(factor * 100);
  }

  // ─── Persistence Helpers ──────────────────────────────────────────────────

  private buildCategoryRows(
    thread: Thread,
    accepted: Array<{
      entry: { slug: string; relevance: number };
      category: ProductCategory;
    }>,
  ): ThreadProductCategory[] {
    return accepted.map((item, index) => {
      const tpc = new ThreadProductCategory();
      tpc.thread = thread;
      tpc.productCategory = item.category;
      tpc.confidence = item.entry.relevance;
      tpc.rank = index;
      return tpc;
    });
  }

  // ─── Misc ──────────────────────────────────────────────────────────────────

  private truncateText(text: string, maxLength: number): string {
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + "...";
  }

  private async recordTrace(
    thread: Thread,
    result: SelectionResult,
    candidates: ProductCategory[],
    llmOutput: {
      categories: Array<{ slug: string; relevance: number }>;
      criteria: RelevanceCriteriaRatings;
    },
    config: ThreadSelectionServiceConfig,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.debugTrace.record({
        threadId: thread.id,
        step: "thread_selection",
        statusBefore: "new",
        statusAfter: result.outcome,
        durationMs,
        model: config.model,
        costLabel: "thread_selection",
        data: {
          summary:
            `Selection outcome: ${result.outcome} ` +
            `(relevance=${result.weightedScore}, ` +
            `categories=${result.categories.length}` +
            (result.hardGateFailedCriteria.length > 0
              ? `, hardGateFailed=[${result.hardGateFailedCriteria.join(",")}]`
              : "") +
            `)`,
          threadSelection: {
            outcome: result.outcome,
            candidateCategories: candidates.map((c) => ({
              slug: c.slug,
              name: c.name,
            })),
            llmCategoryScores: llmOutput.categories,
            acceptedCategories: result.categories,
            criteria: result.criteria,
            hardGateFailedCriteria: result.hardGateFailedCriteria,
            weightedScore: result.weightedScore,
            breakdown: result.breakdown,
            commentsFetched: result.sampledComments.length,
            commentSampleSize: config.commentSampleSize,
            minCategoryRelevance: config.minCategoryRelevance,
            minWeightedScore: config.minWeightedScore,
            model: config.model,
          },
        },
      });
    } catch (error) {
      this.logger.warn(`Failed to record thread_selection trace: ${error}`);
    }
  }
}
