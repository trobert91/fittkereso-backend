import { Test, TestingModule } from "@nestjs/testing";
import { ReferenceRelevanceService } from "./reference-relevance.service";
import {
  ContentQuality,
  Depth,
  ExperienceType,
  Intent,
  ProductReference,
  Quote,
  Sentiment,
} from "@ebike-backend/database";
import { RelevanceConfigService } from "../relevance-config.service";

function createReference(
  overrides: Partial<ProductReference> = {},
): ProductReference {
  return {
    id: "test-ref",
    depth: Depth.Mentioned,
    experience: ExperienceType.Owner,
    quotes: [],
    sentiment: Sentiment.Positive,
    ...overrides,
  } as ProductReference;
}

let __quoteCounter = 0;
function createQuote(
  text: string,
  quality: ContentQuality = "high",
  sentiment = Sentiment.Positive,
): Quote {
  return { id: `q${++__quoteCounter}`, text, sentiment, quality };
}

const STANDARD_BODY =
  "I love the colors on this monitor, response time is 5ms which is great for gaming at 240hz. Build quality feels premium.";

describe("ReferenceRelevanceService", () => {
  let service: ReferenceRelevanceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferenceRelevanceService,
        {
          provide: RelevanceConfigService,
          useValue: {
            config: {
              quoteQualityWeights: {
                high: 1.0,
                medium: 0.85,
                low: 0.4,
              },
              experienceConfig: {
                owner: { multiplier: 1.1, floor: 3 },
                priorOwner: { multiplier: 1.05, floor: 2 },
                tested: { multiplier: 1.0, floor: 1 },
                prospectiveBuyer: { multiplier: 0.85, floor: 0 },
                reference: { multiplier: 0.8, floor: 0 },
              },
            },
          },
        },
      ],
    }).compile();

    service = module.get(ReferenceRelevanceService);
  });

  // ── Quote Quality Multiplier ───────────────────────────────────────────────

  describe("Quote quality multiplier (best-evidence-wins)", () => {
    it("returns 0 when there are no quotes and no other signals", () => {
      const ref = createReference({
        quotes: [],
        depth: Depth.Mentioned,
        experience: ExperienceType.ProspectiveBuyer,
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBe(0);
    });

    it("returns the low weight when there are no quotes but the ref has hands-on experience", () => {
      const ref = createReference({
        quotes: [],
        experience: ExperienceType.Owner,
        depth: Depth.Mentioned,
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBe(0.4);
    });

    it("returns the low weight when there are no quotes but features are derived", () => {
      const ref = createReference({
        quotes: [],
        experience: ExperienceType.ProspectiveBuyer,
        depth: Depth.Mentioned,
        features: [{ label: "HDR", sentiment: Sentiment.Positive }],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBe(0.4);
    });

    it("uses the highest quality across the ref quotes (best evidence wins)", () => {
      const ref = createReference({
        quotes: [
          createQuote("low quality acquisition note", "low"),
          createQuote("medium quality spec mention", "medium"),
          createQuote("high quality first-hand observation", "high"),
        ],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBe(1.0);
    });

    it("falls back to medium when a quote has no quality field", () => {
      const ref = createReference({
        quotes: [
          { id: "q-no-q", text: "unlabeled", sentiment: Sentiment.Positive },
        ],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBe(0.85);
    });

    it("returns the medium weight when only medium quotes are present", () => {
      const ref = createReference({
        quotes: [createQuote("a", "medium"), createQuote("b", "medium")],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBe(0.85);
    });

    it("returns the low weight when only low quotes are present", () => {
      const ref = createReference({
        quotes: [createQuote("a", "low"), createQuote("b", "low")],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBe(0.4);
    });

    it("two high-quality quotes apply a 1.05× volume bump", () => {
      const ref = createReference({
        quotes: [createQuote("a", "high"), createQuote("b", "high")],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBeCloseTo(1.05, 5);
    });

    it("three or more high-quality quotes apply a 1.10× volume bump", () => {
      const ref = createReference({
        quotes: [
          createQuote("a", "high"),
          createQuote("b", "high"),
          createQuote("c", "high"),
        ],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBeCloseTo(1.1, 5);
    });

    it("volume bump caps at three high quotes (4+ stays at 1.10)", () => {
      const ref = createReference({
        quotes: [
          createQuote("a", "high"),
          createQuote("b", "high"),
          createQuote("c", "high"),
          createQuote("d", "high"),
          createQuote("e", "high"),
        ],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBeCloseTo(1.1, 5);
    });

    it("does not bump when only one quote is high (mixed tiers)", () => {
      const ref = createReference({
        quotes: [
          createQuote("a", "high"),
          createQuote("b", "medium"),
          createQuote("c", "low"),
        ],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.quoteQualityMultiplier).toBe(1.0);
    });

    it("does not bump for multiple medium or low quotes (volume only counts for high)", () => {
      const mediumOnly = createReference({
        quotes: [
          createQuote("a", "medium"),
          createQuote("b", "medium"),
          createQuote("c", "medium"),
        ],
      });
      const lowOnly = createReference({
        quotes: [
          createQuote("a", "low"),
          createQuote("b", "low"),
          createQuote("c", "low"),
        ],
      });
      const { factors: mediumFactors } = service.calculateRelevance(
        mediumOnly,
        undefined,
        STANDARD_BODY,
      );
      const { factors: lowFactors } = service.calculateRelevance(
        lowOnly,
        undefined,
        STANDARD_BODY,
      );
      expect(mediumFactors.quoteQualityMultiplier).toBe(0.85);
      expect(lowFactors.quoteQualityMultiplier).toBe(0.4);
    });

    it("higher quality produces a higher score (high > medium > low)", () => {
      const args = {
        depth: Depth.Mentioned,
        experience: ExperienceType.Owner,
      } as const;
      const high = createReference({
        ...args,
        quotes: [createQuote("q", "high")],
      });
      const medium = createReference({
        ...args,
        quotes: [createQuote("q", "medium")],
      });
      const low = createReference({
        ...args,
        quotes: [createQuote("q", "low")],
      });
      const { score: sHigh } = service.calculateRelevance(
        high,
        undefined,
        STANDARD_BODY,
      );
      const { score: sMed } = service.calculateRelevance(
        medium,
        undefined,
        STANDARD_BODY,
      );
      const { score: sLow } = service.calculateRelevance(
        low,
        undefined,
        STANDARD_BODY,
      );
      expect(sHigh).toBeGreaterThan(sMed);
      expect(sMed).toBeGreaterThan(sLow);
    });
  });

  // ── Depth Multiplier ─────────────────────────────────────────────────────

  describe("Depth multiplier", () => {
    const richQuotes = [createQuote("first-hand panel observation", "high")];

    it("comprehensive scores higher than detailed", () => {
      const a = createReference({
        depth: Depth.Comprehensive,
        quotes: richQuotes,
      });
      const b = createReference({ depth: Depth.Detailed, quotes: richQuotes });
      const { score: sa } = service.calculateRelevance(
        a,
        undefined,
        STANDARD_BODY,
      );
      const { score: sb } = service.calculateRelevance(
        b,
        undefined,
        STANDARD_BODY,
      );
      expect(sa).toBeGreaterThan(sb);
    });

    it("detailed scores higher than mentioned", () => {
      const a = createReference({ depth: Depth.Detailed, quotes: richQuotes });
      const b = createReference({ depth: Depth.Mentioned, quotes: richQuotes });
      const { score: sa } = service.calculateRelevance(
        a,
        undefined,
        STANDARD_BODY,
      );
      const { score: sb } = service.calculateRelevance(
        b,
        undefined,
        STANDARD_BODY,
      );
      expect(sa).toBeGreaterThan(sb);
    });

    it("superficial drops the score below 15", () => {
      const ref = createReference({
        depth: Depth.Superficial,
        quotes: richQuotes,
      });
      const { score } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(score).toBeLessThan(15);
    });

    it("undefined depth defaults to mentioned-equivalent", () => {
      const a = createReference({ depth: undefined, quotes: richQuotes });
      const b = createReference({ depth: Depth.Mentioned, quotes: richQuotes });
      const { score: sa } = service.calculateRelevance(
        a,
        undefined,
        STANDARD_BODY,
      );
      const { score: sb } = service.calculateRelevance(
        b,
        undefined,
        STANDARD_BODY,
      );
      expect(Math.abs(sa - sb)).toBeLessThanOrEqual(1);
    });

    it("exposes the depth multiplier on factors", () => {
      const ref = createReference({
        depth: Depth.Comprehensive,
        quotes: richQuotes,
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.depthMultiplier).toBe(1.0);
    });
  });

  // ── Experience Tier ──────────────────────────────────────────────────────

  describe("Experience tier", () => {
    const quotes = [createQuote("first-hand observation", "high")];

    it("owner produces a higher score than reference for the same content", () => {
      const owner = createReference({
        experience: ExperienceType.Owner,
        depth: Depth.Mentioned,
        quotes,
      });
      const ref = createReference({
        experience: ExperienceType.Reference,
        depth: Depth.Mentioned,
        quotes,
      });
      const { score: sOwner } = service.calculateRelevance(
        owner,
        undefined,
        STANDARD_BODY,
      );
      const { score: sRef } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(sOwner).toBeGreaterThan(sRef);
    });

    it("exposes per-tier multipliers and floors", () => {
      const ref = createReference({
        experience: ExperienceType.Owner,
        depth: Depth.Mentioned,
        quotes,
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.experienceMultiplier).toBe(1.1);
      expect(factors.experienceFloorBonus).toBe(3);
    });

    it("undefined experience defaults to reference tier", () => {
      const ref = createReference({
        experience: undefined,
        depth: Depth.Mentioned,
        quotes,
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.experienceMultiplier).toBe(0.8);
      expect(factors.experienceFloorBonus).toBe(0);
    });
  });

  // ── Sentiment ────────────────────────────────────────────────────────────

  describe("Sentiment multiplier", () => {
    it("valenced sentiments get 1.0", () => {
      for (const s of [
        Sentiment.Positive,
        Sentiment.Negative,
        Sentiment.Mixed,
      ]) {
        const ref = createReference({ sentiment: s });
        const { factors } = service.calculateRelevance(ref, undefined);
        expect(factors.sentimentMultiplier).toBe(1.0);
      }
    });

    it("neutral sentiment gets 0.85", () => {
      const ref = createReference({ sentiment: Sentiment.Neutral });
      const { factors } = service.calculateRelevance(ref, undefined);
      expect(factors.sentimentMultiplier).toBe(0.85);
    });

    it("undefined sentiment defaults to neutral (0.85)", () => {
      const ref = createReference({ sentiment: undefined });
      const { factors } = service.calculateRelevance(ref, undefined);
      expect(factors.sentimentMultiplier).toBe(0.85);
    });
  });

  // ── Intent ───────────────────────────────────────────────────────────────

  describe("Intent multiplier", () => {
    const quotes = [createQuote("first-hand", "high")];

    it("firsthand owner with seeking_advice gets 0.5", () => {
      const ref = createReference({
        intents: [Intent.SeekingAdvice],
        depth: Depth.Mentioned,
        quotes,
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.intentMultiplier).toBe(0.5);
    });

    it("secondhand prospective_buyer with seeking_advice gets 0.3", () => {
      const ref = createReference({
        intents: [Intent.SeekingAdvice],
        experience: ExperienceType.ProspectiveBuyer,
        depth: Depth.Mentioned,
        quotes,
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.intentMultiplier).toBe(0.3);
    });

    it("uses the highest intent multiplier when multiple are present", () => {
      const ref = createReference({
        intents: [Intent.SeekingAdvice, Intent.Recommendation],
        depth: Depth.Mentioned,
        quotes,
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.intentMultiplier).toBe(1.0);
    });

    it("empty intents array defaults to 1.0", () => {
      const ref = createReference({
        intents: [],
        depth: Depth.Mentioned,
        quotes,
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.intentMultiplier).toBe(1.0);
    });
  });

  // ── Feature/UseCase Multipliers ─────────────────────────────────────────

  describe("Feature multiplier (S-curve)", () => {
    const quotes = [createQuote("q", "high")];
    const baseArgs = { quotes, depth: Depth.Mentioned } as const;

    it("zero features gets 0.85 penalty", () => {
      const ref = createReference({ ...baseArgs });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.featureMultiplier).toBe(0.85);
    });

    it("three features approaches 1.14", () => {
      const ref = createReference({
        ...baseArgs,
        features: [
          { label: "HDR", sentiment: Sentiment.Positive },
          { label: "colors", sentiment: Sentiment.Positive },
          { label: "response time", sentiment: Sentiment.Positive },
        ],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.featureMultiplier).toBeCloseTo(1.14, 1);
    });

    it("combines positive and negative feature counts", () => {
      const ref = createReference({
        ...baseArgs,
        features: [
          { label: "HDR", sentiment: Sentiment.Positive },
          { label: "stand", sentiment: Sentiment.Negative },
        ],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.featureMultiplier).toBeCloseTo(1.095, 2);
    });
  });

  describe("Use case multiplier (S-curve)", () => {
    const quotes = [createQuote("q", "high")];
    const baseArgs = { quotes, depth: Depth.Mentioned } as const;

    it("zero use cases gets 1.0 (no penalty)", () => {
      const ref = createReference({ ...baseArgs });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.useCaseMultiplier).toBe(1.0);
    });

    it("two use cases approaches ~1.11", () => {
      const ref = createReference({
        ...baseArgs,
        useCases: [
          { label: "gaming", sentiment: Sentiment.Positive },
          { label: "office", sentiment: Sentiment.Positive },
        ],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.useCaseMultiplier).toBeCloseTo(1.113, 2);
    });
  });

  describe("featureUseCaseMultiplier cap", () => {
    const quotes = [createQuote("q", "high")];

    it("caps the combined multiplier at 1.20", () => {
      const ref = createReference({
        quotes,
        depth: Depth.Mentioned,
        features: [
          { label: "HDR", sentiment: Sentiment.Positive },
          { label: "colors", sentiment: Sentiment.Positive },
          { label: "response time", sentiment: Sentiment.Positive },
          { label: "stand", sentiment: Sentiment.Negative },
          { label: "coil whine", sentiment: Sentiment.Negative },
        ],
        useCases: [
          { label: "gaming", sentiment: Sentiment.Positive },
          { label: "office", sentiment: Sentiment.Positive },
          { label: "content creation", sentiment: Sentiment.Positive },
          { label: "streaming", sentiment: Sentiment.Positive },
        ],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.featureUseCaseMultiplier).toBe(1.2);
    });

    it("does not cap when below 1.20", () => {
      const ref = createReference({
        quotes,
        depth: Depth.Mentioned,
        features: [{ label: "HDR", sentiment: Sentiment.Positive }],
        useCases: [{ label: "gaming", sentiment: Sentiment.Positive }],
      });
      const { factors } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(factors.featureUseCaseMultiplier).toBeCloseTo(
        factors.featureMultiplier * factors.useCaseMultiplier,
        3,
      );
    });
  });

  // ── Score Clamping ───────────────────────────────────────────────────────

  describe("Score clamping", () => {
    it("caps the score at 100", () => {
      const ref = createReference({
        experience: ExperienceType.Owner,
        depth: Depth.Comprehensive,
        quotes: [createQuote("q", "high")],
        features: [
          { label: "colors", sentiment: Sentiment.Positive },
          { label: "response time", sentiment: Sentiment.Positive },
          { label: "build quality", sentiment: Sentiment.Positive },
        ],
        useCases: [
          { label: "gaming", sentiment: Sentiment.Positive },
          { label: "media", sentiment: Sentiment.Positive },
        ],
      });
      const { score } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(score).toBe(100);
    });

    it("floors the score at 1", () => {
      const ref = createReference({
        experience: ExperienceType.Reference,
        depth: Depth.Superficial,
        quotes: [],
      });
      const { score } = service.calculateRelevance(ref, undefined);
      expect(score).toBe(1);
    });
  });

  // ── Real-world Scenarios ────────────────────────────────────────────────

  describe("Real-world scenarios", () => {
    it('owner saying "I love it!" with low quality scores below 15', () => {
      const ref = createReference({
        experience: ExperienceType.Owner,
        depth: Depth.Superficial,
        quotes: [createQuote("I love it!", "low")],
      });
      const { score } = service.calculateRelevance(
        ref,
        undefined,
        "I love it!",
      );
      expect(score).toBeLessThan(15);
    });

    it("owner with comprehensive multi-aspect first-hand review scores high", () => {
      const ref = createReference({
        experience: ExperienceType.Owner,
        depth: Depth.Comprehensive,
        quotes: [
          createQuote("Panel quality is excellent", "high"),
          createQuote("Response time measured at 5ms", "medium"),
          createQuote("Build quality is solid", "high"),
        ],
      });
      const { score } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(score).toBeGreaterThanOrEqual(70);
    });

    it("reference-tier citation with medium quality scores moderately", () => {
      const ref = createReference({
        experience: ExperienceType.Reference,
        depth: Depth.Detailed,
        quotes: [
          createQuote("5.2ms response time at 240Hz", "medium"),
          createQuote("peak HDR brightness of 1050 nits", "medium"),
        ],
      });
      const { score } = service.calculateRelevance(
        ref,
        undefined,
        STANDARD_BODY,
      );
      expect(score).toBeGreaterThan(20);
      expect(score).toBeLessThan(60);
    });
  });
});
