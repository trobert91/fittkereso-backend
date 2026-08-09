import { Injectable } from "@nestjs/common";
import { AiChatService } from "@ebike-backend/ai";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { CustomLogger } from "@ebike-backend/logger";

export interface SearchedKeywordSummary {
  keyword: string;
  weeksSinceLastSearch: number;
  threadsDiscovered: number;
  /** Reached ThreadStatus.PROCESSED (full pipeline) — the "useful yield". */
  threadsProcessed: number;
  /** LOW_ESTIMATION + LLM_NO_CATEGORY + LLM_LOW_RELEVANCE. */
  threadsRejected: number;
}

export interface KeywordPlannerInput {
  category: {
    name: string;
    aliases: string[];
    useCases: string[];
    featureLabels: string[];
  };
  baseKeywords: string[];
  year: number;
  topProducts: string[];
  searchedKeywords: SearchedKeywordSummary[];
  /** = ceil(allocatedCount * overFetchMultiplier) — passed to the LLM directly. */
  requestCount: number;
  /** Optional context tags forwarded to AiChatService for trace correlation. */
  batchId?: string;
  categoryId?: string;
  categorySlug?: string;
}

export interface KeywordPlannerOutput {
  keywords: string[];
  /** USD cost of the planner call (provider-reported). 0 if unknown. */
  cost: number;
  /** Wall-clock duration of the planner LLM call in milliseconds. */
  latencyMs: number;
  /** Model used for this call (after dynamic-config resolution). */
  model: string;
}

const DEFAULT_MODEL = "deepseek-v4-flash";
const COST_LABEL = "keyword_research";

const PATTERN_BUCKETS = [
  {
    name: "Generic discovery",
    examples: [
      "best {category}",
      "best {category} {year}",
      "{category} recommendation",
      "{category} buying guide",
    ],
  },
  {
    name: "Tier / price",
    examples: [
      "best budget {category}",
      "best premium {category}",
      "best {category} under $X",
    ],
  },
  {
    name: "Use-case",
    examples: ["best {category} for {useCase}"],
  },
  {
    name: "Feature",
    examples: [
      "best {feature} {category}",
      "{feature} {category} recommendation",
    ],
  },
  {
    name: "Product review",
    examples: ["{product} review", "{product} worth it"],
  },
  {
    name: "Product comparison",
    examples: ["{product} vs {otherProduct}", "{product} alternatives"],
  },
] as const;

@Injectable()
export class KeywordPlannerService {
  private readonly logger = new CustomLogger(KeywordPlannerService.name);

  constructor(
    private readonly aiChatService: AiChatService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  async plan(input: KeywordPlannerInput): Promise<KeywordPlannerOutput> {
    const model =
      this.dynamicConfigService.keywordResearch?.plannerModel ?? DEFAULT_MODEL;

    this.logger.log("Planner call starting", {
      batchId: input.batchId,
      categoryId: input.categoryId,
      categorySlug: input.categorySlug,
      requestCount: input.requestCount,
      baseKeywordCount: input.baseKeywords.length,
      searchedKeywordsCount: input.searchedKeywords.length,
      topProductCount: input.topProducts.length,
      model,
    });

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(input);
    const schema = this.buildSchema(input.requestCount);

    const startTime = Date.now();

    try {
      const response = await this.aiChatService.createChat({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        schema,
        schemaName: "keyword_research_plan",
        strictSchema: true,
        costLabel: COST_LABEL,
        logContext: {
          ...(input.batchId && { batchId: input.batchId }),
          ...(input.categoryId && { categoryId: input.categoryId }),
          ...(input.categorySlug && { categorySlug: input.categorySlug }),
        },
      });

      const parsed = response.parsed as { keywords?: string[] } | undefined;
      const keywords = Array.isArray(parsed?.keywords) ? parsed.keywords : [];

      const latencyMs = Date.now() - startTime;
      const cost = response.cost ?? 0;

      this.logger.log("Planner call complete", {
        batchId: input.batchId,
        categoryId: input.categoryId,
        categorySlug: input.categorySlug,
        returnedCount: keywords.length,
        cost,
        latencyMs,
        model,
        usage: response.usage,
      });

      if (keywords.length < input.requestCount) {
        this.logger.warn("Planner returned fewer keywords than requested", {
          batchId: input.batchId,
          categoryId: input.categoryId,
          categorySlug: input.categorySlug,
          requestCount: input.requestCount,
          returnedCount: keywords.length,
        });
      }

      return { keywords, cost, latencyMs, model };
    } catch (error: unknown) {
      this.logger.error("Planner call failed", {
        batchId: input.batchId,
        categoryId: input.categoryId,
        categorySlug: input.categorySlug,
        model,
        error,
      });
      throw error;
    }
  }

  private buildSchema(count: number): Record<string, unknown> {
    return {
      type: "object",
      additionalProperties: false,
      required: ["keywords"],
      properties: {
        keywords: {
          type: "array",
          minItems: count,
          maxItems: count,
          items: {
            type: "string",
            minLength: 2,
            maxLength: 120,
          },
        },
      },
    };
  }

  private buildSystemPrompt(): string {
    const bucketDescription = PATTERN_BUCKETS.map(
      (bucket) =>
        `- ${bucket.name}: ${bucket.examples.map((e) => `"${e}"`).join(", ")}`,
    ).join("\n");

    return `You generate Reddit search keywords for a product-discovery pipeline. Your output drives weekly searches that surface user discussions about products in a specific category.

The pipeline downstream extracts product opinions from the threads each keyword surfaces. Your job is to maximize the count of high-quality, on-topic threads discovered per keyword search.

KEYWORD PATTERN BUCKETS (mix across these — do not pick all from one bucket):
${bucketDescription}

REQUIREMENTS:
1. Return EXACTLY the requested count of keywords.
2. Cover at least 3 of the 6 buckets above. Aim for at least 2 product-comparison keywords if topProducts are provided. Aim for at least 2 use-case keywords if useCases are provided.
3. Order keywords by your priority: most-promising first. The orchestrator slices the head of the list after cooldown filtering, so put your best bets up top.
4. Favor keyword patterns that historically converted well — look at "searchedKeywords": prefer patterns from rows with high threadsProcessed/threadsDiscovered ratio; avoid patterns from rows with high threadsRejected.
5. Do NOT repeat any keyword from "searchedKeywords" whose weeksSinceLastSearch is less than the cooldown window mentioned in the user prompt. Such keywords are still on cooldown and will be discarded.
6. For comparison keywords, pick plausible competitor pairs from "topProducts" (e.g. same tier, same use case). Don't generate the full Cartesian product.
7. Treat "baseKeywords" as style inspiration — they show the human-curated voice for this category. Don't copy them verbatim; vary the surface form.
8. Use the provided "year" in any year-anchored keyword (don't make up a year).
9. Each keyword should be a natural-sounding Reddit search query: 2–8 words, no quotes, no operators, no leading/trailing whitespace.
10. Lower-case unless a brand/model name requires case.`;
  }

  private buildUserPrompt(input: KeywordPlannerInput): string {
    const {
      category,
      baseKeywords,
      year,
      topProducts,
      searchedKeywords,
      requestCount,
    } = input;
    const cooldownDays =
      this.dynamicConfigService.keywordResearch?.cooldownDays ?? 21;
    const cooldownWeeks = (cooldownDays / 7).toFixed(1);

    const lines: string[] = [];
    lines.push(`CATEGORY: ${category.name}`);
    if (category.aliases.length) {
      lines.push(`Aliases: ${category.aliases.join(", ")}`);
    }
    if (category.useCases.length) {
      lines.push(`Use cases: ${category.useCases.join(", ")}`);
    }
    if (category.featureLabels.length) {
      lines.push(`Feature labels: ${category.featureLabels.join(", ")}`);
    }
    lines.push("");
    lines.push(`YEAR: ${year}`);
    lines.push(
      `COOLDOWN WINDOW: ${cooldownWeeks} weeks (do not reuse keywords searched within this window)`,
    );
    lines.push("");

    if (baseKeywords.length) {
      lines.push("BASE KEYWORDS (style inspiration — do not copy verbatim):");
      for (const keyword of baseKeywords) {
        lines.push(`  - ${keyword}`);
      }
      lines.push("");
    }

    if (topProducts.length) {
      lines.push(
        "TOP PRODUCTS (use these for product-review and comparison keywords):",
      );
      for (const product of topProducts) {
        lines.push(`  - ${product}`);
      }
      lines.push("");
    }

    if (searchedKeywords.length) {
      lines.push("PREVIOUSLY SEARCHED KEYWORDS (with yield stats):");
      lines.push(
        "Columns: keyword | weeks ago | discovered | processed | rejected",
      );
      for (const entry of searchedKeywords) {
        const cells = [
          entry.keyword,
          entry.weeksSinceLastSearch.toFixed(1),
          String(entry.threadsDiscovered),
          String(entry.threadsProcessed),
          String(entry.threadsRejected),
        ];
        lines.push(`  ${cells.join(" | ")}`);
      }
      lines.push("");
    }

    lines.push(
      `Return EXACTLY ${requestCount} keywords in priority order, mixed across buckets.`,
    );

    return lines.join("\n");
  }
}
