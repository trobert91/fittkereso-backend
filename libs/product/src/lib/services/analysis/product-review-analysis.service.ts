import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import {
  getIssueLabels,
  isHandsonExperience,
  ProductLabelSummary,
  ProductModel,
  ProductModelRepository,
  ProductRating,
  ProductRatingHighlight,
  ProductRatingRepository,
  Review,
  ReviewLabelType,
  ReviewRepository,
} from "@ebike-backend/database";
import type { Quote } from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import {
  CategoryConfigService,
  SCHEDULING_DEFAULTS,
} from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { AiChatService } from "@ebike-backend/ai";
import { ProductSpecContextService } from "../product-spec/product-spec-context.service";
import { buildProductReviewAnalysisSystemPrompt } from "./product-review-analysis.prompt";
import {
  buildProductReviewAnalysisJsonSchema,
  ProductReviewAnalysisAllowedLabels,
  ProductReviewAnalysisLabelNarrative,
  ProductReviewAnalysisProCon,
  ProductReviewAnalysisResponse,
  ProductReviewAnalysisResponseSchema,
} from "./product-review-analysis.schema";

interface LabelSelection {
  type: "feature" | "useCase" | "issue";
  summary: ProductLabelSummary;
}

interface EvidenceQuote {
  id: string;
  text: string;
}

interface LabelEvidence {
  selection: LabelSelection;
  quotes: EvidenceQuote[];
}

interface RenderedPrompt {
  prompt: string;
  quoteTextByShortId: Map<string, string>;
}

const COST_LABEL = "product_review_analysis";
const QUOTE_TEXT_TRUNCATION = 600;

@Injectable()
export class ProductReviewAnalysisService {
  private readonly logger = new CustomLogger(ProductReviewAnalysisService.name);

  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly ratingRepo: ProductRatingRepository,
    private readonly reviewRepo: ReviewRepository,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly aiChatService: AiChatService,
    private readonly productSpecContextService: ProductSpecContextService,
  ) {}

  async analyzeProduct(productId: string): Promise<void> {
    const config = this.getConfig();

    const product = await this.productRepo.repo.findOne({
      where: { id: productId },
      relations: { rating: true, productCategory: true },
    });
    if (!product) {
      this.logger.warn("Product not found for analysis", { productId });
      return;
    }
    const rating = product.rating;
    if (!rating) {
      this.logger.warn("Product has no rating; skipping analysis", {
        productId,
      });
      return;
    }

    const reviews = await this.loadReviewSample(
      productId,
      config.reviewSampleSize,
    );
    if (reviews.length === 0) {
      this.logger.warn("No eligible reviews to analyze", { productId });
      return;
    }

    const selectedLabels = this.selectTopLabels(rating, config);
    if (selectedLabels.length === 0) {
      this.logger.warn("No labels available for analysis", { productId });
      return;
    }

    const evidence = this.gatherEvidence(
      selectedLabels,
      reviews,
      config.quotesPerLabel,
    );
    const allowed = this.buildAllowedLabels(product, selectedLabels);
    const systemPrompt = buildProductReviewAnalysisSystemPrompt();
    const { prompt: userPrompt, quoteTextByShortId } = this.buildUserPrompt(
      product,
      rating,
      evidence,
    );

    const schema = buildProductReviewAnalysisJsonSchema(allowed);

    const response = await this.aiChatService.createChat({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      schema,
      schemaName: "product_review_analysis",
      strictSchema: true,
      costLabel: COST_LABEL,
      entityId: productId,
      entityType: "productModel",
    });

    const parsed = this.parseResponse(response.parsed);
    if (!parsed) {
      this.logger.warn("Could not parse analysis response", { productId });
      return;
    }

    await this.persistAnalysis(rating.id, parsed, quoteTextByShortId);
  }

  private async loadReviewSample(
    productId: string,
    limit: number,
  ): Promise<Review[]> {
    return this.reviewRepo.repo
      .createQueryBuilder("review")
      .leftJoinAndSelect("review.labels", "label")
      .where('review."modelId" = :productId', { productId })
      .andWhere(`review.${nameOf<Review>("enabled")} = true`)
      .andWhere(`review.${nameOf<Review>("deletedAt")} IS NULL`)
      .andWhere(`review.${nameOf<Review>("reviewScore")} IS NOT NULL`)
      .orderBy(`review.${nameOf<Review>("reviewScore")}`, "DESC")
      .limit(limit)
      .getMany();
  }

  private selectTopLabels(
    rating: ProductRating,
    config: ResolvedConfig,
  ): LabelSelection[] {
    const out: LabelSelection[] = [];
    for (const summary of (rating.featureSummary ?? []).slice(
      0,
      config.topFeatureLabels,
    )) {
      out.push({ type: "feature", summary });
    }
    for (const summary of (rating.useCaseSummary ?? []).slice(
      0,
      config.topUseCaseLabels,
    )) {
      out.push({ type: "useCase", summary });
    }
    for (const summary of (rating.issueSummary ?? []).slice(
      0,
      config.topIssueLabels,
    )) {
      out.push({ type: "issue", summary });
    }
    return out;
  }

  private gatherEvidence(
    selections: LabelSelection[],
    reviews: Review[],
    quotesPerLabel: number,
  ): LabelEvidence[] {
    return selections.map((selection) => ({
      selection,
      quotes: this.pickQuotesForLabel(selection, reviews, quotesPerLabel),
    }));
  }

  private pickQuotesForLabel(
    selection: LabelSelection,
    reviews: Review[],
    limit: number,
  ): EvidenceQuote[] {
    const matchType = selection.type;
    const name = selection.summary.name;
    const out: EvidenceQuote[] = [];

    for (const review of reviews) {
      if (!isHandsonExperience(review.experience)) continue;
      const reviewMatches = (review.labels ?? []).some(
        (label) =>
          label.type === this.toLabelType(matchType) && label.label === name,
      );
      if (!reviewMatches) continue;

      for (const quote of review.quotes ?? []) {
        if (out.length >= limit) break;
        if (!quote.id) continue;
        if (this.quoteMatchesLabel(quote, matchType, name)) {
          out.push({
            id: quote.id,
            text: this.truncateText(quote.text, QUOTE_TEXT_TRUNCATION),
          });
        }
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  private quoteMatchesLabel(
    quote: Quote,
    type: "feature" | "useCase" | "issue",
    name: string,
  ): boolean {
    if (type === "feature") {
      return (quote.features ?? []).some((e) => e.label === name);
    }
    if (type === "useCase") {
      return (quote.useCases ?? []).some((e) => e.label === name);
    }
    return (quote.issues ?? []).some((e) => e.label === name);
  }

  private toLabelType(type: "feature" | "useCase" | "issue"): ReviewLabelType {
    switch (type) {
      case "feature":
        return ReviewLabelType.Feature;
      case "useCase":
        return ReviewLabelType.UseCase;
      case "issue":
        return ReviewLabelType.Issue;
    }
  }

  private buildAllowedLabels(
    product: ProductModel,
    selections: LabelSelection[],
  ): ProductReviewAnalysisAllowedLabels {
    const categoryConfig = this.categoryConfigService.getConfig(
      product.productCategory?.slug,
    );
    const allFeatureLabels = new Set(
      (categoryConfig?.features ?? []).map((feature) =>
        feature.label.toLowerCase(),
      ),
    );
    const allUseCaseLabels = new Set(
      (categoryConfig?.useCases ?? []).map((useCase) =>
        useCase.label.toLowerCase(),
      ),
    );
    const allIssueLabels = new Set(
      getIssueLabels(categoryConfig).map((issue) => issue.label.toLowerCase()),
    );

    // Emit the summary-side name (the one rendered in the LABELS TO ANALYZE
    // block) so the LLM-emitted name matches both the prompt and the schema
    // enum. Validate membership against the category config case-insensitively,
    // since summaries store names lowercased while configs preserve canonical case.
    const pickAllowed = (
      type: LabelSelection["type"],
      allowed: Set<string>,
    ): string[] =>
      selections
        .filter((selection) => selection.type === type)
        .filter((selection) =>
          allowed.has(selection.summary.name.toLowerCase()),
        )
        .map((selection) => selection.summary.name);

    return {
      features: pickAllowed("feature", allFeatureLabels),
      useCases: pickAllowed("useCase", allUseCaseLabels),
      issues: pickAllowed("issue", allIssueLabels),
    };
  }

  private buildUserPrompt(
    product: ProductModel,
    rating: ProductRating,
    evidence: LabelEvidence[],
  ): RenderedPrompt {
    const lines: string[] = [];
    const quoteTextByShortId = new Map<string, string>();
    let counter = 0;

    const assignShortId = (quote: EvidenceQuote): string => {
      counter += 1;
      const shortId = `q${counter}`;
      quoteTextByShortId.set(shortId, quote.text);
      return shortId;
    };

    lines.push(`PRODUCT: ${product.displayName ?? product.id}`);
    if (product.productCategory?.name) {
      lines.push(`CATEGORY: ${product.productCategory.name}`);
    }
    const specsLine = this.renderProductSpecs(product);
    if (specsLine) {
      lines.push(`SPECS: ${specsLine}`);
    }
    if (rating.rating != null) {
      lines.push(
        `OVERALL RATING: ${rating.rating}/100 across ${rating.totalReviewCount} reviews`,
      );
    }
    lines.push("");

    if (this.hasPriorAnalysis(rating)) {
      lines.push("PREVIOUS ANALYSIS");
      lines.push("-----------------");
      if (rating.tldr) lines.push(`tldr: ${rating.tldr}`);
      if (rating.summary) lines.push(`summary: ${rating.summary}`);
      if (rating.pros?.length) {
        lines.push("pros:");
        for (const pro of rating.pros) lines.push(`  - ${pro.text}`);
      }
      if (rating.cons?.length) {
        lines.push("cons:");
        for (const con of rating.cons) lines.push(`  - ${con.text}`);
      }
      const priorByName = this.priorNarrativesByLabel(rating);
      if (priorByName.size > 0) {
        lines.push("per-label (prior):");
        for (const [name, prior] of priorByName) {
          if (prior.headline || prior.narrative) {
            lines.push(
              `  ${name}: headline=${prior.headline ?? ""}; narrative=${prior.narrative ?? ""}`,
            );
          }
        }
      }
      lines.push("");
    }

    lines.push("LABELS TO ANALYZE");
    lines.push("-----------------");
    for (const item of evidence) {
      const { selection, quotes } = item;
      const summary = selection.summary;
      const pros = summary.strongPositiveCount + summary.positiveCount;
      const cons = summary.strongNegativeCount + summary.negativeCount;
      lines.push("");
      lines.push(
        `[${selection.type}] ${summary.name} — score ${summary.score}, mentions ${summary.mentionCount}, +${pros} / -${cons} / mixed ${summary.mixedCount} / neutral ${summary.neutralCount}`,
      );
      if (quotes.length === 0) {
        lines.push(
          "  (no quotes available — narrate cautiously, based on counts only)",
        );
      } else {
        for (const quote of quotes) {
          const shortId = assignShortId(quote);
          lines.push(`  - [${shortId}] "${quote.text}"`);
        }
      }
    }

    return { prompt: lines.join("\n"), quoteTextByShortId };
  }

  private renderProductSpecs(product: ProductModel): string {
    const contextSpecs = this.productSpecContextService.getSpecsForContext(
      product,
      product.productCategory ?? undefined,
      { productModelId: product.id },
    );
    if (contextSpecs.length > 0) {
      return contextSpecs.join(", ");
    }
    return (product.orderedSpecs ?? [])
      .filter(
        (spec) =>
          spec.value !== undefined &&
          spec.value !== null &&
          typeof spec.value !== "boolean",
      )
      .map((spec) => String(spec.value))
      .join(", ");
  }

  private hasPriorAnalysis(rating: ProductRating): boolean {
    return rating.lastSummaryGeneratedAt != null;
  }

  private priorNarrativesByLabel(
    rating: ProductRating,
  ): Map<string, { headline?: string; narrative?: string }> {
    const map = new Map<string, { headline?: string; narrative?: string }>();
    for (const summary of [
      ...(rating.featureSummary ?? []),
      ...(rating.useCaseSummary ?? []),
      ...(rating.issueSummary ?? []),
    ]) {
      if (summary.headline || summary.narrative) {
        map.set(summary.name, {
          headline: summary.headline,
          narrative: summary.narrative,
        });
      }
    }
    return map;
  }

  private parseResponse(parsed: unknown): ProductReviewAnalysisResponse | null {
    if (parsed == null) return null;
    const result = ProductReviewAnalysisResponseSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn("Analysis response failed schema validation", {
        issues: result.error.issues.slice(0, 5),
      });
      return null;
    }
    return result.data;
  }

  private async persistAnalysis(
    ratingId: string,
    parsed: ProductReviewAnalysisResponse,
    quoteTextByShortId: Map<string, string>,
  ): Promise<void> {
    const fresh = await this.ratingRepo.repo.findOne({
      where: { id: ratingId },
    });
    if (!fresh) {
      this.logger.warn("Rating row vanished before analysis persistence", {
        ratingId,
      });
      return;
    }

    const generatedAt = new Date().toISOString();

    fresh.featureSummary = this.applyNarrativesByName(
      fresh.featureSummary,
      parsed.featureLabels,
      generatedAt,
    );
    fresh.useCaseSummary = this.applyNarrativesByName(
      fresh.useCaseSummary,
      parsed.useCaseLabels,
      generatedAt,
    );
    fresh.issueSummary = this.applyNarrativesByName(
      fresh.issueSummary,
      parsed.issueLabels,
      generatedAt,
    );

    fresh.tldr = parsed.tldr;
    fresh.summary = parsed.summary;
    fresh.pros = parsed.pros.map((entry) =>
      this.resolveHighlight(entry, quoteTextByShortId),
    );
    fresh.cons = parsed.cons.map((entry) =>
      this.resolveHighlight(entry, quoteTextByShortId),
    );
    fresh.lastSummaryGeneratedAt = new Date();
    fresh.reviewCountAtLastSummary = fresh.totalReviewCount;

    await this.ratingRepo.save(fresh);
  }

  private resolveHighlight(
    entry: ProductReviewAnalysisProCon,
    quoteTextByShortId: Map<string, string>,
  ): ProductRatingHighlight {
    const seen = new Set<string>();
    const quotes: string[] = [];
    for (const shortId of entry.quoteIds) {
      const text = quoteTextByShortId.get(shortId);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      quotes.push(text);
      if (quotes.length >= 3) break;
    }
    return { text: entry.text, quotes };
  }

  private applyNarrativesByName(
    summary: ProductLabelSummary[] | null | undefined,
    narratives: ProductReviewAnalysisLabelNarrative[],
    generatedAt: string,
  ): ProductLabelSummary[] | null {
    if (!summary?.length) return summary ?? null;
    const narrativesByName = new Map<
      string,
      ProductReviewAnalysisLabelNarrative
    >();
    for (const narrative of narratives) {
      narrativesByName.set(narrative.name.toLowerCase(), narrative);
    }
    return summary.map((entry) => {
      const narrative = narrativesByName.get(entry.name.toLowerCase());
      if (!narrative) return entry;
      return {
        ...entry,
        headline: narrative.headline,
        narrative: narrative.narrative,
        narrativeGeneratedAt: generatedAt,
      };
    });
  }

  private truncateText(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + "…";
  }

  private getConfig(): ResolvedConfig {
    const dynamic = this.dynamicConfigService.scheduling?.productReviewAnalysis;
    const defaults = (
      SCHEDULING_DEFAULTS as typeof SCHEDULING_DEFAULTS & {
        productReviewAnalysis: ProductReviewAnalysisDefaults;
      }
    ).productReviewAnalysis;
    return {
      topFeatureLabels: dynamic?.topFeatureLabels ?? defaults.topFeatureLabels,
      topUseCaseLabels: dynamic?.topUseCaseLabels ?? defaults.topUseCaseLabels,
      topIssueLabels: dynamic?.topIssueLabels ?? defaults.topIssueLabels,
      quotesPerLabel: dynamic?.quotesPerLabel ?? defaults.quotesPerLabel,
      reviewSampleSize: dynamic?.reviewSampleSize ?? defaults.reviewSampleSize,
      model: dynamic?.model ?? defaults.model,
    };
  }
}

interface ResolvedConfig {
  topFeatureLabels: number;
  topUseCaseLabels: number;
  topIssueLabels: number;
  quotesPerLabel: number;
  reviewSampleSize: number;
  model: string;
}

interface ProductReviewAnalysisDefaults {
  topFeatureLabels: number;
  topUseCaseLabels: number;
  topIssueLabels: number;
  quotesPerLabel: number;
  reviewSampleSize: number;
  model: string;
  [key: string]: unknown;
}
