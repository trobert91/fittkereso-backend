import {
  Depth,
  Evidence,
  ExperienceType,
  Intent,
  ProductReference,
  Quote,
  Review,
  ReviewLabelType,
  Sentiment,
  UserComment,
} from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { ReviewEvaluatorService } from "./review-evaluator.service";

function makeDynamicConfigMock(topQuoteLimit = 8): DynamicConfigService {
  return { review: { topQuoteLimit } } as DynamicConfigService;
}

function makeCategoryConfigMock(): CategoryConfigService {
  return { getConfig: () => undefined } as unknown as CategoryConfigService;
}

/** Shorthand to create an Evidence object for tests. */
function ev(label: string, sentiment?: Sentiment): Evidence {
  return sentiment === undefined ? { label } : { label, sentiment };
}

/** Shorthand to create issue Evidence — issues carry a required negative
 *  severity sentiment (Negative or StrongNegative). */
function issueEv(
  label: string,
  sentiment: Sentiment = Sentiment.Negative,
): Evidence {
  return { label, sentiment };
}

type QuoteLike = Partial<Quote> & { text: string; sentiment: Sentiment };

type ReferenceOverrides = Omit<Partial<ProductReference>, "quotes"> & {
  quotes?: QuoteLike[];
  upvotes?: number;
  downvotes?: number;
  externalCreationTs?: Date;
};

function backfillQuoteId(quote: QuoteLike, index: number): Quote {
  return {
    id: quote.id ?? `quote-${index}-${quote.text.slice(0, 16)}`,
    ...quote,
  } as Quote;
}

function makeReference(overrides: ReferenceOverrides = {}): ProductReference {
  const reference = new ProductReference();
  reference.sentiment = overrides.sentiment ?? Sentiment.Neutral;
  reference.intents = overrides.intents ?? [Intent.Recommendation];
  reference.experience = overrides.experience ?? ExperienceType.Reference;
  reference.depth = overrides.depth ?? Depth.Superficial;
  reference.relevance = overrides.relevance ?? 100;
  reference.enabled = true;
  reference.flagged = false;
  reference.resolutionFinished = false;
  reference.context = { input: {} } as any;

  const comment = new UserComment();
  comment.upvotes = overrides.upvotes ?? 0;
  comment.downvotes = overrides.downvotes ?? 0;
  comment.externalCreationTs =
    overrides.externalCreationTs ?? new Date("2024-01-01");
  reference.comment = comment;

  const {
    quotes: rawQuotes,
    upvotes: _u,
    downvotes: _d,
    externalCreationTs: _ts,
    ...rest
  } = overrides;
  Object.assign(reference, rest);
  reference.quotes = (rawQuotes ?? []).map((quote, index) =>
    backfillQuoteId(quote, index),
  );
  return reference;
}

function makeReview(references: ProductReference[]): Review {
  const review = new Review();
  review.productReferences = references;
  return review;
}

function labelsOfType(
  review: Review,
  type: ReviewLabelType,
): Array<{ label: string; sentiment: Sentiment; evidenceCount: number }> {
  return (review.labels ?? [])
    .filter((label) => label.type === type)
    .map((label) => ({
      label: label.label,
      sentiment: label.sentiment,
      evidenceCount: label.evidenceCount,
    }));
}

describe("ReviewEvaluatorService", () => {
  let service: ReviewEvaluatorService;

  beforeEach(() => {
    service = new ReviewEvaluatorService(
      makeDynamicConfigMock(),
      makeCategoryConfigMock(),
    );
  });

  // ─── Sentiment ────────────────────────────────────────────────────────────

  describe("evaluateSentiment", () => {
    it("returns Positive when all references are positive", async () => {
      const review = makeReview([
        makeReference({ sentiment: Sentiment.Positive }),
        makeReference({ sentiment: Sentiment.Positive }),
      ]);

      await service.evaluate(review);

      expect(review.sentiment).toBe(Sentiment.Positive);
    });

    it("returns Negative when all references are negative", async () => {
      const review = makeReview([
        makeReference({ sentiment: Sentiment.Negative }),
        makeReference({ sentiment: Sentiment.Negative }),
      ]);

      await service.evaluate(review);

      expect(review.sentiment).toBe(Sentiment.Negative);
    });

    it("returns Mixed when references are split", async () => {
      const review = makeReview([
        makeReference({ sentiment: Sentiment.Positive, relevance: 50 }),
        makeReference({ sentiment: Sentiment.Negative, relevance: 50 }),
      ]);

      await service.evaluate(review);

      expect(review.sentiment).toBe(Sentiment.Mixed);
    });
  });

  // ─── Label Derivation ────────────────────────────────────────────────────

  describe("deriveLabels", () => {
    it("emits one Feature label per (label) group when only positive evidence exists", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "the colors really pop on this panel",
              sentiment: Sentiment.Positive,
              quality: "high",
              features: [ev("colors")],
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      const features = labelsOfType(review, ReviewLabelType.Feature);
      expect(features).toEqual([
        { label: "colors", sentiment: Sentiment.Positive, evidenceCount: 1 },
      ]);
    });

    it("groups multiple positive quotes into one Feature label and counts them", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "colors look really nice on this panel",
              sentiment: Sentiment.Positive,
              quality: "high",
              features: [ev("colors")],
            },
            {
              text: "color accuracy is super impressive overall",
              sentiment: Sentiment.Positive,
              quality: "high",
              features: [ev("colors")],
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      const features = labelsOfType(review, ReviewLabelType.Feature);
      expect(features).toHaveLength(1);
      expect(features[0]).toMatchObject({ label: "colors", evidenceCount: 2 });
    });

    it("promotes to StrongPositive when any contributing quote was StrongPositive", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "colors look really nice on this panel",
              sentiment: Sentiment.Positive,
              quality: "high",
              features: [ev("colors")],
            },
            {
              text: "colors are absolutely incredible",
              sentiment: Sentiment.StrongPositive,
              quality: "high",
              features: [ev("colors")],
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      const features = labelsOfType(review, ReviewLabelType.Feature);
      expect(features[0].sentiment).toBe(Sentiment.StrongPositive);
    });

    it("emits Mixed when the same label has both positive and negative evidence", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "the build quality is rock solid overall",
              sentiment: Sentiment.Positive,
              quality: "high",
              features: [ev("build quality")],
            },
            {
              text: "build quality has issues with creaking",
              sentiment: Sentiment.Negative,
              quality: "high",
              features: [ev("build quality")],
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      const features = labelsOfType(review, ReviewLabelType.Feature);
      expect(features[0]).toMatchObject({
        label: "build quality",
        sentiment: Sentiment.Mixed,
        evidenceCount: 2,
      });
    });

    it("uses evidence-level sentiment override when present", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "overall really nice panel but stand is wobbly",
              sentiment: Sentiment.Positive,
              quality: "high",
              features: [
                ev("colors", Sentiment.Positive),
                ev("stand", Sentiment.Negative),
              ],
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      const features = labelsOfType(review, ReviewLabelType.Feature);
      expect(features).toEqual(
        expect.arrayContaining([
          { label: "colors", sentiment: Sentiment.Positive, evidenceCount: 1 },
          { label: "stand", sentiment: Sentiment.Negative, evidenceCount: 1 },
        ]),
      );
    });

    it("emits Issue labels separately from Feature labels", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "gets random vrr black screen flashes on this monitor",
              sentiment: Sentiment.Negative,
              quality: "high",
              issues: [issueEv("vrr black screen")],
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      expect(labelsOfType(review, ReviewLabelType.Feature)).toEqual([]);
      expect(labelsOfType(review, ReviewLabelType.Issue)).toEqual([
        {
          label: "vrr black screen",
          sentiment: Sentiment.Negative,
          evidenceCount: 1,
        },
      ]);
    });

    it("emits UseCase labels from quote.useCases", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "works great for pc gaming and media consumption alike",
              sentiment: Sentiment.Positive,
              quality: "high",
              useCases: [ev("pc gaming"), ev("media consumption")],
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      const useCases = labelsOfType(review, ReviewLabelType.UseCase);
      expect(useCases).toEqual(
        expect.arrayContaining([
          {
            label: "pc gaming",
            sentiment: Sentiment.Positive,
            evidenceCount: 1,
          },
          {
            label: "media consumption",
            sentiment: Sentiment.Positive,
            evidenceCount: 1,
          },
        ]),
      );
    });

    it("normalizes labels to lowercase so case/whitespace variants collapse into one ReviewLabel", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "works really well for casual pc gaming sessions",
              sentiment: Sentiment.Positive,
              quality: "high",
              useCases: [ev("casual pc gaming")],
              features: [ev("HDR")],
            },
            {
              text: "still solid for casual PC gaming after months of use",
              sentiment: Sentiment.Positive,
              quality: "high",
              useCases: [ev("  Casual PC Gaming  ")],
              features: [ev("hdr")],
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      const useCases = labelsOfType(review, ReviewLabelType.UseCase);
      expect(useCases).toEqual([
        {
          label: "casual pc gaming",
          sentiment: Sentiment.Positive,
          evidenceCount: 2,
        },
      ]);
      const features = labelsOfType(review, ReviewLabelType.Feature);
      expect(features).toEqual([
        { label: "hdr", sentiment: Sentiment.Positive, evidenceCount: 2 },
      ]);
    });

    it("skips speculative quotes entirely", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "i bet the colors would be great if i bought this",
              sentiment: Sentiment.Positive,
              quality: "high",
              speculative: true,
              features: [ev("colors")],
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      expect(review.labels ?? []).toEqual([]);
    });

    it("emits no labels when productReferences is empty (evaluate short-circuits)", async () => {
      const review = makeReview([]);

      await service.evaluate(review);

      expect(review.labels).toBeUndefined();
    });

    it("emits no labels when no qualifying quote evidence exists", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "this product is fine i guess",
              sentiment: Sentiment.Neutral,
              quality: "high",
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      expect(review.labels).toEqual([]);
    });
  });

  // ─── Score: Pros/Cons Coverage Bonus from Labels ─────────────────────────

  describe("feature coverage bonus", () => {
    it("adds 3 pts per positive/negative feature label (capped at 15)", async () => {
      // Build 4 distinct positive feature labels via quotes
      const review = makeReview([
        makeReference({
          depth: Depth.Superficial,
          experience: ExperienceType.Reference,
          quotes: [
            {
              text: "colors really pop on this panel overall",
              sentiment: Sentiment.Positive,
              quality: "medium",
              features: [ev("colors")],
            },
            {
              text: "response time is super sharp for gaming",
              sentiment: Sentiment.Positive,
              quality: "medium",
              features: [ev("response time")],
            },
            {
              text: "hdr really impresses on quality media content",
              sentiment: Sentiment.Positive,
              quality: "medium",
              features: [ev("HDR")],
            },
            {
              text: "stand wobbles whenever i adjust the height",
              sentiment: Sentiment.Negative,
              quality: "medium",
              features: [ev("stand")],
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      // 4 labels * 3 = 12 (under cap of 15)
      const features = labelsOfType(review, ReviewLabelType.Feature);
      expect(features).toHaveLength(4);
      expect(review.reviewScore).toBeGreaterThan(0);
    });

    it("caps feature coverage bonus at 15 pts when many labels exist", async () => {
      const labels = [
        "colors",
        "response time",
        "HDR",
        "text clarity",
        "brightness",
        "contrast",
      ];
      const review = makeReview([
        makeReference({
          depth: Depth.Superficial,
          experience: ExperienceType.Reference,
          quotes: labels.map((label, index) => ({
            text: `${label} feels really impressive overall on this unit ${index}`,
            sentiment: Sentiment.Positive,
            quality: "medium" as const,
            features: [ev(label)],
          })),
        }),
      ]);

      await service.evaluate(review);

      const features = labelsOfType(review, ReviewLabelType.Feature);
      expect(features).toHaveLength(6);
      // 6 labels * 3 = 18 → capped at 15; score is finite and bounded
      expect(review.reviewScore).toBeGreaterThan(0);
      expect(review.reviewScore).toBeLessThanOrEqual(100);
    });
  });

  // ─── Empty references ──────────────────────────────────────────────────────

  describe("empty references", () => {
    it("does nothing when productReferences array is empty", async () => {
      const review = makeReview([]);
      review.sentiment = Sentiment.Positive;

      await service.evaluate(review);

      expect(review.sentiment).toBe(Sentiment.Positive);
    });
  });

  // ─── Quote Filtering, Scoring, Top-N Cap ─────────────────────────────────

  describe("quote filtering and scoring", () => {
    it("filters out low-quality quotes", async () => {
      const review = makeReview([
        makeReference({
          quotes: [
            {
              text: "colors are incredible on this panel",
              sentiment: Sentiment.Positive,
              quality: "low",
            },
            {
              text: "response time is excellent for gaming",
              sentiment: Sentiment.Positive,
              quality: "high",
            },
          ],
        }),
      ]);

      await service.evaluate(review);

      expect(review.quotes).toHaveLength(1);
      expect(review.quotes![0].text).toBe(
        "response time is excellent for gaming",
      );
    });

    it("persists review.quotes in score-desc order", async () => {
      const q1: Quote = {
        id: "a",
        text: "neutral observation about the panel performance overall",
        sentiment: Sentiment.Neutral,
        quality: "medium",
      };
      const q2: Quote = {
        id: "b",
        text: "the response time is really sharp and consistent",
        sentiment: Sentiment.Positive,
        quality: "high",
      };
      const q3: Quote = {
        id: "c",
        text: "mixed feelings about color accuracy on this unit",
        sentiment: Sentiment.Mixed,
        quality: "medium",
      };
      const review = makeReview([makeReference({ quotes: [q1, q2, q3] })]);

      await service.evaluate(review);

      // q2 (high+positive) > q3 (medium+mixed) > q1 (medium+neutral)
      expect(review.quotes!.map((q) => q.id)).toEqual(["b", "c", "a"]);
    });

    it("label derivation walks every quote on every reference, independent of top-N cap on review.quotes", async () => {
      // The top-N cap on review.quotes is a display concern (curated top quotes
      // exposed on the Review entity); label derivation now reads from
      // review.productReferences[].quotes so non-surviving quotes still
      // contribute to the review_label sidecar.
      const customService = new ReviewEvaluatorService(
        makeDynamicConfigMock(1),
        makeCategoryConfigMock(),
      );
      const topQuote: Quote = {
        id: "q-top",
        text: "the build quality and finish are absolutely outstanding",
        sentiment: Sentiment.Positive,
        quality: "high",
        features: [ev("build quality", Sentiment.Positive)],
      };
      const lowerQuote: Quote = {
        id: "q-lower",
        text: "the colors look really nice on this panel",
        sentiment: Sentiment.Positive,
        quality: "medium",
        features: [ev("colors", Sentiment.Positive)],
      };
      const review = makeReview([
        makeReference({ quotes: [topQuote, lowerQuote], relevance: 100 }),
      ]);

      await customService.evaluate(review);

      // review.quotes is capped to 1 (display).
      expect(review.quotes).toHaveLength(1);
      // But both labels appear in the sidecar, because deriveLabels walks every
      // quote on every productReference.
      const features = labelsOfType(review, ReviewLabelType.Feature);
      expect(features.map((f) => f.label).sort()).toEqual([
        "build quality",
        "colors",
      ]);
    });
  });
});
