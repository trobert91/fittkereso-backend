import { Test, TestingModule } from "@nestjs/testing";
import { ProductCategory } from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { CategoryContentRelevanceScorerService } from "./category-content-relevance-scorer.service";
import { ScoringConfigService } from "../scoring-config.service";

interface ScorerSetupOptions {
  relevanceTerms?: Array<{
    keyword: string;
    weight: number;
    exclusive?: boolean;
  }>;
  keywordIdentifiers?: string[];
  negativeTerms?: Array<{ keyword: string; penalty: number }>;
  configOverrides?: Partial<{
    topKeywordCount: number;
    fuzzyThreshold: number;
    categoryNameWeight: number;
    categoryAliasWeight: number;
    keywordIdentifierWeight: number;
    phraseBoostBase: number;
    referenceMatchesPerTerm: number;
    referenceWeightPerTerm: number;
    referenceCorpusDivisor: number;
    exclusiveTermBoost: number;
    negativeTermFloor: number;
  }>;
}

const DEFAULT_CONFIG = {
  topKeywordCount: 8,
  fuzzyThreshold: 0.9,
  categoryNameWeight: 4,
  categoryAliasWeight: 3,
  keywordIdentifierWeight: 1,
  phraseBoostBase: 1.5,
  referenceMatchesPerTerm: 3,
  referenceWeightPerTerm: 2,
  referenceCorpusDivisor: 20,
  exclusiveTermBoost: 0.05,
  negativeTermFloor: 0.4,
};

async function buildScorer(
  options: ScorerSetupOptions = {},
): Promise<CategoryContentRelevanceScorerService> {
  const config = { ...DEFAULT_CONFIG, ...(options.configOverrides ?? {}) };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      CategoryContentRelevanceScorerService,
      {
        provide: ScoringConfigService,
        useValue: { categoryRelevance: config },
      },
      {
        provide: CategoryConfigService,
        useValue: {
          getConfig: () => ({
            relevanceTerms: options.relevanceTerms ?? [],
            keywordIdentifiers: options.keywordIdentifiers ?? [],
            negativeTerms: options.negativeTerms ?? [],
          }),
        },
      },
    ],
  }).compile();

  return module.get<CategoryContentRelevanceScorerService>(
    CategoryContentRelevanceScorerService,
  );
}

function makeCategory(
  name = "Monitors",
  slug = "monitors",
  aliases: string[] = [],
): ProductCategory {
  const category = new ProductCategory();
  category.name = name;
  category.slug = slug;
  category.aliases = aliases;
  return category;
}

describe("CategoryContentRelevanceScorerService", () => {
  describe("basic matching", () => {
    it("returns undefined when no content is provided", async () => {
      const scorer = await buildScorer({
        relevanceTerms: [{ keyword: "monitor", weight: 2.5 }],
      });

      const result = scorer.getRelevance(makeCategory(), []);

      expect(result).toBeUndefined();
    });

    it("returns undefined when no terms match", async () => {
      const scorer = await buildScorer({
        relevanceTerms: [{ keyword: "monitor", weight: 2.5 }],
      });

      const result = scorer.getRelevance(makeCategory(), [
        "unrelated content about cars",
      ]);

      expect(result).toBeUndefined();
    });

    it("returns a positive relevance when terms match", async () => {
      const scorer = await buildScorer({
        relevanceTerms: [{ keyword: "monitor", weight: 2.5 }],
      });

      const result = scorer.getRelevance(makeCategory(), [
        "looking for a new monitor under 500 dollars",
      ]);

      expect(result).toBeDefined();
      expect(result!.relevance).toBeGreaterThan(0);
      expect(result!.relevance).toBeLessThanOrEqual(100);
    });
  });

  describe("frequency saturation", () => {
    it("rewards repeated matches with diminishing returns", async () => {
      const scorer = await buildScorer({
        relevanceTerms: [{ keyword: "monitor", weight: 2.5 }],
      });

      const single = scorer.getRelevance(makeCategory(), ["I want a monitor"]);
      const repeated = scorer.getRelevance(makeCategory(), [
        "monitor",
        "monitor",
        "monitor",
        "monitor",
      ]);

      expect(single).toBeDefined();
      expect(repeated).toBeDefined();
      expect(repeated!.relevance).toBeGreaterThan(single!.relevance);
    });

    it("does not blow past 100 when a term is matched many times", async () => {
      const scorer = await buildScorer({
        relevanceTerms: [{ keyword: "monitor", weight: 2.5 }],
      });

      const corpus = Array.from({ length: 50 }, () => "monitor");
      const result = scorer.getRelevance(makeCategory(), corpus);

      expect(result!.relevance).toBeLessThanOrEqual(100);
    });
  });

  describe("top-K matched terms", () => {
    it("does not penalize categories with many configured terms but few matches", async () => {
      // Two categories with the same matched terms but different total config size.
      const fewTermsScorer = await buildScorer({
        relevanceTerms: [
          { keyword: "monitor", weight: 2.5 },
          { keyword: "display", weight: 2.0 },
        ],
      });
      const manyTermsScorer = await buildScorer({
        relevanceTerms: [
          { keyword: "monitor", weight: 2.5 },
          { keyword: "display", weight: 2.0 },
          { keyword: "g-sync", weight: 2.2 },
          { keyword: "freesync", weight: 2.2 },
          { keyword: "response time", weight: 1.8 },
          { keyword: "refresh rate", weight: 1.6 },
          { keyword: "panel uniformity", weight: 1.8 },
          { keyword: "backlight bleed", weight: 1.8 },
        ],
      });

      const content = ["I love this monitor and the display is great"];
      const few = fewTermsScorer.getRelevance(makeCategory(), content);
      const many = manyTermsScorer.getRelevance(makeCategory(), content);

      expect(few).toBeDefined();
      expect(many).toBeDefined();
      // Both should produce the same relevance since the same terms matched.
      expect(many!.relevance).toBe(few!.relevance);
    });

    it("uses only the top-K matched terms (matches beyond K do not lift the score)", async () => {
      const scorer = await buildScorer({
        relevanceTerms: [
          { keyword: "monitor", weight: 2.5 },
          { keyword: "display", weight: 2.0 },
          { keyword: "screen", weight: 2.0 },
          { keyword: "panel", weight: 1.8 },
          { keyword: "gaming", weight: 1.5 },
        ],
        configOverrides: { topKeywordCount: 2 },
      });

      const fullCorpus = ["monitor display screen panel gaming"];
      const result = scorer.getRelevance(makeCategory(), fullCorpus);

      expect(result).toBeDefined();
      expect(result!.topTerms).toHaveLength(2);
    });
  });

  describe("exclusive term bonus", () => {
    it("lifts the score when exclusive terms match", async () => {
      const baseScorer = await buildScorer({
        relevanceTerms: [
          { keyword: "monitor", weight: 2.5 },
          { keyword: "display", weight: 2.0 },
        ],
      });
      const exclusiveScorer = await buildScorer({
        relevanceTerms: [
          { keyword: "monitor", weight: 2.5 },
          { keyword: "display", weight: 2.0 },
          { keyword: "g-sync", weight: 2.2, exclusive: true },
          { keyword: "freesync", weight: 2.2, exclusive: true },
        ],
      });

      const content = [
        "this monitor has a great display with g-sync and freesync",
      ];
      const base = baseScorer.getRelevance(makeCategory(), content);
      const exclusive = exclusiveScorer.getRelevance(makeCategory(), content);

      expect(exclusive!.relevance).toBeGreaterThan(base!.relevance);
      expect(exclusive!.exclusiveMatchCount).toBe(2);
    });

    it("caps the final relevance at 100 even with many exclusive matches", async () => {
      const scorer = await buildScorer({
        relevanceTerms: [
          { keyword: "monitor", weight: 2.5 },
          { keyword: "g-sync", weight: 2.2, exclusive: true },
          { keyword: "freesync", weight: 2.2, exclusive: true },
          { keyword: "ultrawide", weight: 2.0, exclusive: true },
          { keyword: "ips panel", weight: 1.8, exclusive: true },
        ],
        configOverrides: { exclusiveTermBoost: 0.5 },
      });

      const content = ["monitor g-sync freesync ultrawide ips panel"];
      const result = scorer.getRelevance(makeCategory(), content);

      expect(result!.relevance).toBeLessThanOrEqual(100);
    });
  });

  describe("negative term penalty", () => {
    it("reduces the score when a negative term is present", async () => {
      const scorer = await buildScorer({
        relevanceTerms: [{ keyword: "monitor", weight: 2.5 }],
        negativeTerms: [{ keyword: "broken", penalty: 0.5 }],
      });

      const cleanContent = ["I need a new monitor"];
      const negativeContent = ["I need a new monitor but it is broken"];

      const clean = scorer.getRelevance(makeCategory(), cleanContent);
      const negative = scorer.getRelevance(makeCategory(), negativeContent);

      expect(negative!.relevance).toBeLessThan(clean!.relevance);
      expect(negative!.negativePenalty).toBe(0.5);
    });

    it("respects the negative term floor", async () => {
      const scorer = await buildScorer({
        relevanceTerms: [{ keyword: "monitor", weight: 2.5 }],
        negativeTerms: [
          { keyword: "broken", penalty: 0.1 },
          { keyword: "damaged", penalty: 0.1 },
        ],
        configOverrides: { negativeTermFloor: 0.4 },
      });

      const result = scorer.getRelevance(makeCategory(), [
        "broken damaged monitor",
      ]);

      expect(result!.negativePenalty).toBe(0.4);
    });
  });

  describe("phrase boost", () => {
    it("values multi-word matches above single-word matches of the same weight", async () => {
      const phraseScorer = await buildScorer({
        relevanceTerms: [{ keyword: "gaming monitor", weight: 2.0 }],
      });
      const wordScorer = await buildScorer({
        relevanceTerms: [{ keyword: "monitor", weight: 2.0 }],
      });

      const phrase = phraseScorer.getRelevance(makeCategory(), [
        "gaming monitor",
      ]);
      const word = wordScorer.getRelevance(makeCategory(), ["monitor"]);

      expect(phrase!.relevance).toBeGreaterThan(word!.relevance);
    });
  });

  describe("score interpretation", () => {
    it("produces ~30-50 for an average match", async () => {
      // Mid-quality: 3 of 8 terms matched once each, no exclusives.
      const scorer = await buildScorer({
        relevanceTerms: [
          { keyword: "monitor", weight: 2.5 },
          { keyword: "display", weight: 2.0 },
          { keyword: "screen", weight: 2.0 },
          { keyword: "g-sync", weight: 2.2 },
          { keyword: "freesync", weight: 2.2 },
          { keyword: "ips panel", weight: 1.8 },
          { keyword: "response time", weight: 1.8 },
          { keyword: "refresh rate", weight: 1.6 },
        ],
      });

      const result = scorer.getRelevance(makeCategory(), [
        "looking at a new monitor with a nice display and big screen",
      ]);

      expect(result!.relevance).toBeGreaterThanOrEqual(20);
      expect(result!.relevance).toBeLessThanOrEqual(60);
    });

    it("produces 80+ for an overwhelming match", async () => {
      // Many matches, with repetition and exclusives.
      const scorer = await buildScorer({
        relevanceTerms: [
          { keyword: "monitor", weight: 2.5 },
          { keyword: "display", weight: 2.0 },
          { keyword: "g-sync", weight: 2.2, exclusive: true },
          { keyword: "freesync", weight: 2.2, exclusive: true },
          { keyword: "ultrawide", weight: 2.0, exclusive: true },
          { keyword: "ips panel", weight: 1.8 },
          { keyword: "response time", weight: 1.8 },
          { keyword: "refresh rate", weight: 1.6 },
        ],
      });

      const corpus = [
        "this monitor is amazing",
        "great display quality",
        "g-sync works perfectly",
        "love freesync too",
        "ultrawide is a game changer",
        "monitor refresh rate",
        "low response time",
        "crisp ips panel",
        "best monitor for ultrawide",
        "g-sync compatible monitor",
      ];
      const result = scorer.getRelevance(makeCategory(), corpus);

      expect(result!.relevance).toBeGreaterThanOrEqual(80);
    });
  });
});
