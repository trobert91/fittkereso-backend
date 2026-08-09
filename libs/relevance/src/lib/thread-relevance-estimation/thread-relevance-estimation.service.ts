import { Injectable } from "@nestjs/common";
import {
  PlatformSearchResult,
  ProductCategory,
  ProductCategoryRepository,
  ThreadPlatform,
} from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import { BrandCacheService } from "@ebike-backend/product";
import { isUserComment, RedditThreadService } from "@ebike-backend/reddit";
import { normalize } from "@ebike-backend/utils";
import { compact, uniq } from "lodash";
import { CategoryContentRelevanceScorerService } from "../services/category-content-relevance-scorer.service";

export interface CategoryScoreBreakdown {
  slug: string;
  name: string;
  /** Final relevance after subreddit boost, 0-100. */
  relevance: number;
  /** Boost added from a matching subreddit entry in the category config, or 0. */
  subredditBoost: number;
}

/**
 * Programmatic mirrors of the Stage 2 LLM criteria, plus `category`.
 *
 * Each signal is the cheap-scorer's approximation of what the LLM rates in
 * `ThreadSelectionService`. Names align with `RelevanceCriteriaRatings` so a
 * thread's Stage 1 signals and Stage 2 criteria can be compared side by side.
 * All values are 0-100. The cheap scorer stays intentionally permissive —
 * false negatives at Stage 1 are never reprocessed, so it errs on the side of
 * letting borderline threads through to the LLM.
 */
export interface SignalScores {
  /** Top category relevance after subreddit boost, 0-100. */
  category: number;
  /** First-person ownership / hands-on language ("i bought", "my experience"). 0-100. */
  experienceDensity: number;
  /**
   * Whether commenters actually name products. Counts how many *distinct*
   * comments mention a known brand (name or alias from BrandCacheService).
   * Model-number-shaped regex extraction was tried earlier but produced too
   * many false positives on URL slugs / Reddit IDs / usernames; ground-truth
   * brand mentions are the more reliable cheap signal. Junk threads
   * (giveaways, cleaning tips, accessory chatter) score low because nobody
   * brings specific brands into the conversation; multi-category PCMR-style
   * threads score high but are caught downstream by the soft-gate
   * `multiCategoryDiffuse` branch instead. 0-100.
   */
  productSpecificity: number;
  /**
   * Density of category-vocabulary hits in *comment* bodies only — feature /
   * issue / useCase labels plus category name, aliases, keywordIdentifiers,
   * and relevanceTerms keywords. Title vocabulary is subtracted out so
   * threads where commenters just echo the title's terms ("OLED", "500Hz")
   * cannot saturate this signal, and the score is capped by the number of
   * distinct comments that contribute hits — many repetitions across a few
   * commenters don't outweigh a wider conversation. 0-100.
   */
  featureDiscussion: number;
  /** Review-seeking / opinion-seeking language ("worth it", "recommend", "should i buy"). 0-100. */
  buyerResearchValue: number;
  /** Direct comparison language ("vs", "compared to", "switched from"). 0-100. */
  comparativeContent: number;
}

export interface ThreadRelevanceEstimationResult {
  /**
   * Combined 0-100 score. Weighted sum of the five criteria signals
   * (matching the Stage 2 LLM weights) plus the category signal, with the
   * category contribution discounted when the top category does not clearly
   * dominate the runner-up (`categoryFocus`). The score is permissive —
   * false negatives at Stage 1 are more costly than false positives, since
   * the LLM in Stage 2 has the final say.
   */
  score: number;
  /** Per-signal breakdown. */
  signals: SignalScores;
  /**
   * 0-1 gap between the top category and the runner-up, expressed as a fraction
   * of the top score. 1 means the top category dominates (single-topic thread);
   * 0 means several categories tied (general / off-topic chatter). Used to
   * discount the category contribution in the combined score.
   */
  categoryFocus: number;
  /** Number of top-level comments included in the corpus. */
  commentCount: number;
  /** True if the Reddit comment fetch failed; score is based on title + text only. */
  commentFetchFailed: boolean;
  /** Size of the corpus that was scored (title + text + comments). */
  corpusSize: number;
  /** Top scoring categories, sorted desc. Kept for diagnostics. */
  topCategories: CategoryScoreBreakdown[];
}

const TOP_LEVEL_COMMENT_LIMIT = 25;
const TOP_CATEGORY_BREAKDOWN_LIMIT = 5;
/** Cheap-scorer relevance floor for which categories contribute their vocab
 *  to `featureDiscussion`. Below this is treated as background noise — matches
 *  the spirit of Stage 2's `minCategoryRelevance` (which is higher because the
 *  LLM is more precise; we stay lenient so genuinely about-X threads still
 *  feed terms even when the cheap scorer underrates them). */
const FEATURE_SIGNAL_CATEGORY_FLOOR = 25;
const FEATURE_SIGNAL_CATEGORY_LIMIT = 3;

/**
 * Soft junk gate thresholds. The gate fires (combined score × penalty) when
 * `experienceDensity` is low AND one of:
 *   - `productSpecificity` is also low (nobody names any products and nobody
 *     describes ownership → not a review thread)
 *   - `categoryFocus` is below the diffuse-thread threshold (the thread
 *     covers many categories at once → product names that did appear are
 *     scattered across off-topic categories, not concentrated on the one
 *     we'd actually want to extract reviews for; classic PCMR dream-build /
 *     general-PC-chatter pattern)
 *
 * Either condition combined with low experience density indicates the thread
 * cannot carry useful review content regardless of how saturated its category
 * vocabulary or raw product-naming looks.
 */
const SOFT_GATE_PRODUCT_SPECIFICITY_THRESHOLD = 30;
const SOFT_GATE_EXPERIENCE_THRESHOLD = 35;
const SOFT_GATE_CATEGORY_FOCUS_THRESHOLD = 0.4;
const SOFT_GATE_PENALTY = 0.4;

const BUYER_RESEARCH_TERMS: TermWeight[] = [
  // Explicit research-question phrases
  { term: "review", weight: 1.6 },
  { term: "reviews", weight: 1.6 },
  { term: "opinion", weight: 1.4 },
  { term: "opinions", weight: 1.4 },
  { term: "thoughts", weight: 1.2 },
  { term: "feedback", weight: 1.2 },
  { term: "worth it", weight: 1.5 },
  { term: "worth buying", weight: 1.5 },
  { term: "worth the money", weight: 1.4 },
  { term: "not worth", weight: 1.3 },
  { term: "recommend", weight: 1.3 },
  { term: "recommendation", weight: 1.3 },
  { term: "recommendations", weight: 1.3 },
  { term: "would recommend", weight: 1.5 },
  { term: "i would recommend", weight: 1.6 },
  { term: "highly recommend", weight: 1.6 },
  { term: "can't recommend", weight: 1.5 },
  { term: "cannot recommend", weight: 1.5 },
  { term: "should i buy", weight: 1.5 },
  { term: "should i get", weight: 1.4 },
  { term: "is it worth", weight: 1.4 },
  { term: "is it good", weight: 1.2 },
  { term: "is it really", weight: 1.2 },
  { term: "any good", weight: 1.2 },
  { term: "looking for advice", weight: 1.2 },
  { term: "help me choose", weight: 1.3 },
  { term: "pros and cons", weight: 1.3 },
  { term: "pros cons", weight: 1.1 },
  // Sentiment-as-recommendation — broader patterns people actually use to
  // share a buying verdict. Lower weights since these fire outside product
  // contexts; they earn their keep via coverage, not per-term saturation.
  { term: "in my opinion", weight: 1.2 },
  { term: "imo", weight: 0.9 },
  { term: "love it", weight: 0.9 },
  { term: "absolutely love", weight: 1.1 },
  { term: "really love", weight: 1.0 },
  { term: "really like", weight: 0.9 },
  { term: "love mine", weight: 1.2 },
  { term: "great monitor", weight: 1.1 },
  { term: "great display", weight: 1.1 },
  { term: "amazing display", weight: 1.0 },
  { term: "the best", weight: 0.7 },
  { term: "not a bad", weight: 1.0 },
  { term: "not bad at all", weight: 1.0 },
  // Negative buying verdicts
  { term: "avoid", weight: 1.2 },
  { term: "stay away", weight: 1.4 },
  { term: "save your money", weight: 1.4 },
  { term: "i regret", weight: 1.4 },
  { term: "regret buying", weight: 1.5 },
  { term: "wish i had", weight: 1.0 },
  // Satisfaction-validation phrases lifted from
  // RelevanceTermsService.defaultTerms. These read as recommendations even
  // when the word "recommend" doesn't appear — common on long ownership
  // threads where users just describe how they feel after buying.
  { term: "i love my", weight: 1.4 },
  { term: "couldn't be happier", weight: 1.5 },
  { term: "no complaints", weight: 1.4 },
  { term: "no issues", weight: 1.3 },
  // Active-research phrases — strong buyer-intent signals
  { term: "did a ton of research", weight: 1.5 },
  { term: "leaning toward", weight: 1.3 },
  { term: "landed on", weight: 1.3 },
  { term: "had to return", weight: 1.4 },
  // Defect / dissatisfaction language — only a real owner who used the
  // product complains about specific malfunctions. Higher weight on the
  // verdict-shaped ones ("should i return", "defective"), lower on the
  // diagnostic verbs which can appear in non-product contexts ("crashing"
  // can be about software, "overheating" can be about a room).
  { term: "doesn't work", weight: 1.4 },
  { term: "not working", weight: 1.3 },
  { term: "defective", weight: 1.4 },
  { term: "faulty", weight: 1.3 },
  { term: "overheating", weight: 1.2 },
  { term: "crashing", weight: 1.1 },
  { term: "flickering", weight: 1.3 },
  { term: "should i return", weight: 1.4 },
];

const COMPARATIVE_TERMS: TermWeight[] = [
  { term: "vs", weight: 1.1 },
  { term: "versus", weight: 1.3 },
  { term: "compare", weight: 1.2 },
  { term: "compared to", weight: 1.4 },
  { term: "comparison", weight: 1.3 },
  { term: "switched from", weight: 1.5 },
  { term: "came from", weight: 1.2 },
  { term: "upgraded from", weight: 1.4 },
  { term: "downgraded from", weight: 1.4 },
  { term: "better than", weight: 1.2 },
  { term: "worse than", weight: 1.2 },
  { term: "instead of", weight: 1.0 },
  { term: "side by side", weight: 1.3 },
  { term: "or the", weight: 0.6 },
  // Upgrade-context phrases lifted from
  // RelevanceTermsService.defaultTerms — explicit upgrade comparisons.
  { term: "worth the upgrade", weight: 1.4 },
  { term: "huge upgrade", weight: 1.5 },
  { term: "big upgrade", weight: 1.4 },
  { term: "upgrade over", weight: 1.4 },
];

const EXPERIENCE_TERMS: TermWeight[] = [
  { term: "i bought", weight: 1.5 },
  { term: "i purchased", weight: 1.5 },
  { term: "i own", weight: 1.3 },
  // "i have" / "i use" / "i used" are weakened (down from 0.8 / 1.1 / 1.1)
  // because they fire on advice-giving threads about anything ("I use
  // distilled water", "I use motor oil" on a monitor-cleaning thread). The
  // more specific variants below ("i have the", "i use the") still carry
  // ownership weight because the trailing article almost always implies
  // a referenced product.
  { term: "i have", weight: 0.5 },
  { term: "i got", weight: 1.1 },
  { term: "i recently got", weight: 1.4 },
  { term: "i tested", weight: 1.3 },
  { term: "i tried", weight: 1.2 },
  { term: "i use", weight: 0.7 },
  { term: "i used", weight: 0.7 },
  { term: "i upgraded", weight: 1.3 },
  { term: "my experience", weight: 1.5 },
  { term: "my impressions", weight: 1.4 },
  { term: "first impressions", weight: 1.4 },
  { term: "hands on", weight: 1.3 },
  { term: "after using", weight: 1.3 },
  { term: "after a month", weight: 1.2 },
  { term: "after a year", weight: 1.2 },
  { term: "long term", weight: 1.2 },
  { term: "daily use", weight: 1.2 },
  { term: "daily driver", weight: 1.2 },
  { term: "out of the box", weight: 1.2 },
  { term: "came from", weight: 1.2 },
  { term: "switched from", weight: 1.3 },
  { term: "on par with", weight: 1.1 },
  // Ownership-validation phrases lifted from RelevanceTermsService.defaultTerms
  // (the downstream per-comment scorer's curated list). These are more
  // specific ownership signals — higher weight than the bare "i own"/"i use"
  // variants because the trailing "the" makes them less likely to fire on
  // generic non-product clauses.
  { term: "i have the", weight: 1.3 },
  { term: "i own the", weight: 1.4 },
  { term: "i use the", weight: 1.2 },
  { term: "picked mine up", weight: 1.2 },
  { term: "just got", weight: 1.3 },
  { term: "got it today", weight: 1.4 },
  { term: "previously had", weight: 1.2 },
  // Past-tense ownership with implied time scope — observed in real owner
  // threads ("I've had mine for almost a year", "I have had this for a year").
  // High weight because the contraction + past tense almost never fires
  // outside genuine ownership statements.
  { term: "i've had", weight: 1.3 },
  { term: "i have had", weight: 1.3 },
  // Setup language — first-person interaction with the device after acquiring
  // it. Lower weight than direct ownership claims since "set it up" can also
  // appear in advice/help contexts, but in practice it fires on owners.
  { term: "set it up", weight: 1.1 },
  { term: "set mine up", weight: 1.2 },
];

interface TermWeight {
  term: string;
  weight: number;
}

/**
 * Cheap programmatic pre-filter run at ingestion time.
 *
 * Mirrors the Stage 2 LLM's rubric so signals here line up 1:1 with the
 * LLM's criteria on a thread, on a corpus of title + text + up to 25 top-level
 * comments fetched in a single Reddit call:
 *   1. **category**            — top enabled category's relevance after subreddit boost
 *   2. **experienceDensity**   — first-person ownership / hands-on language
 *   3. **productSpecificity**  — model-number tokens and brand mentions across
 *                                distinct commenters (cheap proxy for "people
 *                                are actually naming products")
 *   4. **featureDiscussion**   — comment-side density of category-vocabulary
 *                                hits with title-vocab subtracted, capped by
 *                                distinct-commenter diversity
 *   5. **buyerResearchValue**  — review-seeking / opinion-seeking language
 *   6. **comparativeContent**  — direct comparison language
 *
 * Combined as a weighted sum, with the category contribution discounted by a
 * `categoryFocus` factor (how clearly the top category outscores the runner-up).
 * Threads on general subreddits like r/pcmasterrace tend to saturate several
 * peripheral categories at once; the focus factor catches that and prevents
 * undiscriminating category saturation from dominating the score.
 *
 * A soft junk gate then applies: when both `productSpecificity` and
 * `experienceDensity` come back low, the thread cannot be talking about real
 * products from real owners regardless of how saturated its category vocab is,
 * and the combined score is penalised. This catches giveaway / accessory /
 * cleaning-tip threads that saturate category vocab without ever naming a
 * specific product or describing ownership.
 *
 * The goal at Stage 1 is to drop obvious garbage — false positives are
 * cheaper than false negatives, since the LLM in Stage 2 has the final say.
 */
@Injectable()
export class ThreadRelevanceEstimationService {
  private readonly logger = new CustomLogger(
    ThreadRelevanceEstimationService.name,
  );

  constructor(
    private readonly categoryRepository: ProductCategoryRepository,
    private readonly categoryScorer: CategoryContentRelevanceScorerService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly redditThreadService: RedditThreadService,
    private readonly brandCacheService: BrandCacheService,
  ) {}

  public async score(
    result: PlatformSearchResult,
  ): Promise<ThreadRelevanceEstimationResult> {
    const corpus = await this.buildCorpus(result);

    return this.scoreCorpus(
      corpus.titleAndText,
      corpus.commentBodies,
      this.extractSubreddit(result),
      corpus.commentCount,
      corpus.commentFetchFailed,
    );
  }

  /**
   * Pull a Reddit subreddit slug out of a search result. The `topic` field
   * carries it for Reddit results; other platforms (forum URLs, Hacker News,
   * Twitter) have nothing equivalent, so we return null and the subreddit
   * boost step in `scoreCategories` is skipped. Reddit `topic` values
   * conventionally look like "r/Monitors"; we keep the value verbatim since
   * `subreddits[].name` in category config is stored in the same form.
   */
  private extractSubreddit(result: PlatformSearchResult): string | null {
    if (result.platform !== ThreadPlatform.Reddit) return null;
    return result.topic ? result.topic : null;
  }

  // ─── Scoring core ──────────────────────────────────────────────────────────

  private async scoreCorpus(
    titleAndText: string[],
    commentBodies: string[],
    subreddit: string | null,
    commentCount: number,
    commentFetchFailed: boolean,
  ): Promise<ThreadRelevanceEstimationResult> {
    const corpus = [...titleAndText, ...commentBodies];
    if (corpus.length === 0) {
      return {
        score: 0,
        signals: {
          category: 0,
          experienceDensity: 0,
          productSpecificity: 0,
          featureDiscussion: 0,
          buyerResearchValue: 0,
          comparativeContent: 0,
        },
        categoryFocus: 0,
        commentCount,
        commentFetchFailed,
        corpusSize: 0,
        topCategories: [],
      };
    }

    const { topCategories, categoryScore, topCategoryEntities } =
      await this.scoreCategories(corpus, subreddit);

    const normalizedCorpus = corpus.map((part) => normalize(part));
    const normalizedComments = commentBodies.map((part) => normalize(part));
    const normalizedTitleAndText = titleAndText.map((part) => normalize(part));

    const featureTerms = this.collectFeatureTerms(topCategoryEntities);
    const brandTerms = await this.brandCacheService.getCachedBrandTerms();

    const signals: SignalScores = {
      category: categoryScore,
      experienceDensity: this.scoreTermSignal(
        normalizedCorpus,
        EXPERIENCE_TERMS,
      ),
      productSpecificity: this.scoreProductSpecificity(
        normalizedComments,
        brandTerms,
      ),
      featureDiscussion: this.scoreFeatureDiscussion(
        normalizedComments,
        normalizedTitleAndText,
        featureTerms,
      ),
      buyerResearchValue: this.scoreTermSignal(
        normalizedCorpus,
        BUYER_RESEARCH_TERMS,
      ),
      comparativeContent: this.scoreTermSignal(
        normalizedCorpus,
        COMPARATIVE_TERMS,
      ),
    };

    const categoryFocus = this.computeCategoryFocus(topCategories);

    return {
      score: this.combine(signals, categoryFocus),
      signals,
      categoryFocus,
      commentCount,
      commentFetchFailed,
      corpusSize: corpus.length,
      topCategories,
    };
  }

  // ─── Corpus building ────────────────────────────────────────────────────────

  private async buildCorpus(result: PlatformSearchResult): Promise<{
    titleAndText: string[];
    commentBodies: string[];
    commentCount: number;
    commentFetchFailed: boolean;
  }> {
    const titleAndText = compact([result.title, result.text]);
    let commentBodies: string[] = [];
    let commentFetchFailed = false;

    try {
      const submission = await this.redditThreadService.getThread(
        result.externalId,
        TOP_LEVEL_COMMENT_LIMIT,
      );
      commentBodies = (submission.comments ?? [])
        .filter((comment: { body?: string; author?: { name?: string } }) =>
          isUserComment({
            body: comment.body,
            authorName: comment.author?.name,
          }),
        )
        .map((comment: { body: string }) => comment.body);
    } catch (error) {
      commentFetchFailed = true;
      this.logger.warn(
        `Failed to fetch comments for relevance estimation, falling back to title + text`,
        { externalId: result.externalId, error },
      );
    }

    return {
      titleAndText,
      commentBodies,
      commentCount: commentBodies.length,
      commentFetchFailed,
    };
  }

  // ─── Category signal ────────────────────────────────────────────────────────

  private async scoreCategories(
    corpus: string[],
    subreddit: string | null,
  ): Promise<{
    topCategories: CategoryScoreBreakdown[];
    categoryScore: number;
    topCategoryEntities: ProductCategory[];
  }> {
    const categories = await this.categoryRepository.getAll({
      where: { enabled: true },
    });
    const allResults = this.categoryScorer.resolveByContent(corpus, categories);

    if (allResults.length === 0) {
      return { topCategories: [], categoryScore: 0, topCategoryEntities: [] };
    }

    const boostBySlug = new Map<string, number>();
    if (subreddit) {
      for (const scored of allResults) {
        const catConfig = this.categoryConfigService.getConfig(
          scored.category.slug,
        );
        const subredditMatch = catConfig?.subreddits?.find(
          (sub) => sub.name.toLowerCase() === subreddit.toLowerCase(),
        );
        if (subredditMatch) {
          const boostedRelevance = Math.min(
            100,
            scored.relevance + subredditMatch.boost,
          );
          boostBySlug.set(
            scored.category.slug,
            boostedRelevance - scored.relevance,
          );
          scored.relevance = boostedRelevance;
        }
      }
      allResults.sort((a, b) => b.relevance - a.relevance);
    }

    const topCategories: CategoryScoreBreakdown[] = allResults
      .slice(0, TOP_CATEGORY_BREAKDOWN_LIMIT)
      .map((scored) => ({
        slug: scored.category.slug,
        name: scored.category.name,
        relevance: scored.relevance,
        subredditBoost: boostBySlug.get(scored.category.slug) ?? 0,
      }));

    // For per-category feature/anchor signals we use only categories that
    // are plausibly the thread's topic — filter at the same floor used by
    // computeCategoryFocus so a single dominant category drives the signal.
    const topCategoryEntities = allResults
      .filter((scored) => scored.relevance >= FEATURE_SIGNAL_CATEGORY_FLOOR)
      .slice(0, FEATURE_SIGNAL_CATEGORY_LIMIT)
      .map((scored) => scored.category);

    return {
      topCategories,
      categoryScore: allResults[0].relevance,
      topCategoryEntities,
    };
  }

  // ─── Term-pattern signals (intent, experience) ─────────────────────────────

  /**
   * Score a fixed list of weighted terms against a normalized corpus, on a
   * 0-100 scale. Combines a saturating-frequency score over the top-6 matched
   * terms with a coverage component (fraction of the term list matched at all).
   *
   * Saturation is intentionally weakly dependent on corpus size: long threads
   * have more vocabulary variance, so a single confident hit on a high-weight
   * term ("highly recommend", "stay away") should still register meaningfully
   * even when no other hits of that exact phrase appear. Per-term saturation
   * caps between 2 hits (short threads / small lists) and 4 hits (long
   * threads), so a thread with diverse mentions across several terms can
   * still saturate without needing many repetitions of any one phrase.
   */
  private scoreTermSignal(
    normalizedCorpus: string[],
    terms: TermWeight[],
  ): number {
    if (terms.length === 0 || normalizedCorpus.length === 0) return 0;

    const maxOccurrences = Math.max(
      2,
      Math.min(4, Math.round(normalizedCorpus.length / 25)),
    );
    const maxFreqBoost = Math.sqrt(maxOccurrences);

    const termScores = terms.map(({ term, weight }) => {
      const occurrences = normalizedCorpus.filter((part) =>
        part.includes(term),
      ).length;
      if (occurrences === 0) return { score: 0, matched: false, max: 0 };

      const frequencyBoost = Math.sqrt(occurrences);
      const spaceCount = (term.match(/ /g) ?? []).length;
      const phraseBoost = spaceCount > 0 ? Math.pow(1.5, spaceCount) : 1;
      const rawScore = occurrences * weight * frequencyBoost * phraseBoost;

      const max = maxOccurrences * weight * maxFreqBoost * phraseBoost;

      return { score: Math.min(rawScore, max), matched: true, max };
    });

    const topN = 6;
    const topTerms = termScores
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    const scoreTotal = topTerms.reduce((sum, t) => sum + t.score, 0);
    const scoreMax = topTerms.reduce((sum, t) => sum + t.max, 0) || 1;
    const normalizedScore = Math.min(1, scoreTotal / scoreMax);

    const matchedCount = termScores.filter((t) => t.matched).length;
    const coverage = matchedCount / Math.min(10, terms.length);

    return Math.round((normalizedScore * 0.7 + coverage * 0.3) * 100);
  }

  // ─── Per-category term collection ──────────────────────────────────────────

  /**
   * Assemble a deduplicated, lowercased term list that represents the
   * category's full vocabulary: feature/issue/useCase labels (what the LLM
   * extracts) plus category name, aliases, keyword identifiers, and
   * relevance-term keywords (what humans use to talk about the category).
   *
   * Casting a wider net than the LLM's extraction vocab is intentional —
   * Stage 1 is a permissive pre-filter. A thread that says "IPS panel" or
   * "1440p" is talking about monitors even if it never mentions a specific
   * feature label.
   *
   * When no top categories survived the floor, return an empty list — the
   * resulting featureDiscussion score will be 0, which is the right answer
   * (no category context = nothing to talk *about*).
   */
  private collectFeatureTerms(
    topCategoryEntities: ProductCategory[],
  ): TermWeight[] {
    const labels: string[] = [];
    for (const category of topCategoryEntities) {
      if (category.name) labels.push(category.name);
      for (const alias of category.aliases ?? []) {
        if (alias) labels.push(alias);
      }
      const config = this.categoryConfigService.getConfig(category.slug);
      if (!config) continue;
      for (const feature of config.features ?? []) {
        if (feature.label) labels.push(feature.label);
      }
      for (const issue of config.issues ?? []) {
        if (issue.label) labels.push(issue.label);
      }
      for (const useCase of config.useCases ?? []) {
        if (useCase.label) labels.push(useCase.label);
      }
      for (const keyword of config.keywordIdentifiers ?? []) {
        if (keyword) labels.push(keyword);
      }
      for (const relevanceTerm of config.relevanceTerms ?? []) {
        if (relevanceTerm.keyword) labels.push(relevanceTerm.keyword);
      }
    }
    return uniq(labels.map((label) => label.toLowerCase().trim()))
      .filter((label) => label.length >= 3)
      .map((term) => ({ term, weight: 1 }));
  }

  // ─── Signal combination ────────────────────────────────────────────────────

  /**
   * How distinctly the top category outscored the second one, as a fraction of
   * the top score. 1.0 means the top category dominates; 0.0 means several
   * categories tied. Used to discount the category contribution when the
   * "winning" category is essentially tied with peers (a sign the thread is
   * general chatter rather than focused on any one category).
   */
  private computeCategoryFocus(
    topCategories: CategoryScoreBreakdown[],
  ): number {
    if (topCategories.length === 0 || topCategories[0].relevance === 0) {
      return 0;
    }
    if (topCategories.length === 1) return 1;
    const top = topCategories[0].relevance;
    const second = topCategories[1].relevance;
    return Math.max(0, Math.min(1, (top - second) / top));
  }

  // ─── productSpecificity ────────────────────────────────────────────────────

  /**
   * Score how concretely the comment corpus names products, 0-100. Counts the
   * number of *distinct comment bodies* that mention a known brand (name or
   * alias) from the global BrandCache. We previously combined this with a
   * model-number regex extractor, but model-name shapes are too varied to
   * regex reliably ("G85SD", "341cqpx", "RX 7800 XT", "DDR5-6000", URL slugs)
   * — the false positives dominated. Ground-truth brand mentions catch the
   * real review threads while keeping the surface area small.
   *
   * Counted across *distinct comment bodies*, not raw hits — a single
   * commenter spamming "Samsung Samsung Samsung" should not look like a
   * multi-perspective product thread. The sqrt taper saturates around 5
   * distinct commenters: 1 → 45, 3 → ~78, 5+ → ~100.
   */
  private scoreProductSpecificity(
    normalizedComments: string[],
    brandTerms: string[],
  ): number {
    if (normalizedComments.length === 0 || brandTerms.length === 0) return 0;

    let commentsWithBrandMention = 0;
    for (const normalizedBody of normalizedComments) {
      const padded = ` ${normalizedBody} `;
      const hit = brandTerms.some((brand) => padded.includes(` ${brand} `));
      if (hit) commentsWithBrandMention += 1;
    }

    return Math.min(100, Math.round(Math.sqrt(commentsWithBrandMention) * 45));
  }

  // ─── featureDiscussion (with title-bias subtraction + diversity cap) ────────

  /**
   * Score feature discussion density on the comment side only, with two
   * defences against vocabulary saturation:
   *
   *  1. **Title-vocab subtraction.** Terms that appear in title + selftext are
   *     dropped from the matching list for comments. A giveaway thread whose
   *     title says "500Hz OLED" is *already* a vocabulary anchor; commenters
   *     parroting "OLED" back at it isn't discussion, it's response.
   *  2. **Distinct-comment diversity cap.** The score is multiplied by the
   *     fraction of comments that contributed at least one feature-term hit.
   *     Many hits across few commenters cannot saturate; we want breadth.
   *
   * When titleAndText absorbs the entire feature vocab (very common with
   * giveaway-style prompts), the residual term list is empty and the signal
   * correctly scores 0. That is the desired behaviour.
   */
  private scoreFeatureDiscussion(
    normalizedComments: string[],
    normalizedTitleAndText: string[],
    featureTerms: TermWeight[],
  ): number {
    if (featureTerms.length === 0 || normalizedComments.length === 0) return 0;

    const titleBlob = normalizedTitleAndText.join(" ");
    const residualTerms = featureTerms.filter(
      ({ term }) => !titleBlob.includes(term),
    );
    if (residualTerms.length === 0) return 0;

    const baseScore = this.scoreTermSignal(normalizedComments, residualTerms);
    if (baseScore === 0) return 0;

    const commentsWithHit = normalizedComments.filter((part) =>
      residualTerms.some(({ term }) => part.includes(term)),
    ).length;

    // Diversity factor: fraction of comments that contributed any feature
    // hit, with a floor so a small but on-topic thread isn't crushed. Cap at
    // 1.0 (no bonus for "more diversity than full coverage").
    const diversity = Math.min(
      1,
      0.4 + (0.6 * commentsWithHit) / Math.max(1, normalizedComments.length),
    );

    return Math.round(baseScore * diversity);
  }

  // ─── Signal combination ────────────────────────────────────────────────────

  /**
   * Combine the per-signal scores into a single 0-100 estimate.
   *
   * The criteria mirror Stage 2's LLM rubric: experienceDensity and
   * productSpecificity together carry the "this is real product talk"
   * weight (a thread without first-person ownership *or* concrete product
   * names is not a review thread), then featureDiscussion (category-vocab
   * density) and buyerResearchValue, with comparativeContent rounding it
   * out. Their combined contribution is blended with the standalone
   * `category` signal (discounted by `categoryFocus` so general-chatter
   * threads cannot saturate the score across multiple weak categories).
   *
   * A soft junk gate then halves the score when `experienceDensity` is low
   * AND one of: `productSpecificity` is also low (nobody owns anything and
   * nobody names anything — giveaways, cleaning tips, accessory questions),
   * or `categoryFocus` is below the diffuse threshold (multi-category PCMR
   * dream-build threads where product names exist but are scattered across
   * CPUs / RAM / boards / monitors rather than concentrated on the category
   * we'd actually want to extract reviews for).
   *
   * The blend stays permissive — Stage 1 cares about dropping obvious junk,
   * not making the final call. Threads that score borderline pass through to
   * the Stage 2 LLM, which is the actual arbiter.
   *
   * Focus discount rules:
   *  - When the top category is high-confidence (≥ HIGH_CONFIDENCE_CATEGORY)
   *    the focus discount is skipped entirely. The estimator trusts the
   *    category signal and ignores noisy runner-ups.
   *  - Otherwise the discount is lenient (`0.7 + 0.3 × focus`), so even a
   *    fully saturated thread retains 70% of its category signal.
   */
  private combine(signals: SignalScores, categoryFocus: number): number {
    const HIGH_CONFIDENCE_CATEGORY = 80;
    const effectiveFocus =
      signals.category >= HIGH_CONFIDENCE_CATEGORY ? 1 : categoryFocus;
    const focusedCategory = signals.category * (0.7 + 0.3 * effectiveFocus);

    const criteriaScore =
      signals.experienceDensity * 0.25 +
      signals.productSpecificity * 0.25 +
      signals.featureDiscussion * 0.15 +
      signals.buyerResearchValue * 0.2 +
      signals.comparativeContent * 0.15;

    // 40% category / 60% criteria — keeps category as a strong gate against
    // off-topic threads while letting the criteria carry the actual
    // research-value signal once a category clearly matches.
    let score = focusedCategory * 0.4 + criteriaScore * 0.6;

    // Soft junk gate: when ownership talk is absent AND (no specific products
    // OR the thread is diffuse across many categories), apply a strong
    // penalty. Even fully saturated category vocab and a high productSpecificity
    // cannot rescue a thread where nobody owns anything and the product names
    // that did appear are scattered across off-topic categories — that's
    // classic PCMR dream-build / general-chatter junk.
    const productSpecificityLow =
      signals.productSpecificity < SOFT_GATE_PRODUCT_SPECIFICITY_THRESHOLD;
    const experienceLow =
      signals.experienceDensity < SOFT_GATE_EXPERIENCE_THRESHOLD;
    const multiCategoryDiffuse =
      categoryFocus < SOFT_GATE_CATEGORY_FOCUS_THRESHOLD;
    if (experienceLow && (productSpecificityLow || multiCategoryDiffuse)) {
      score *= SOFT_GATE_PENALTY;
    }

    return Math.round(Math.min(100, Math.max(0, score)));
  }
}
