import {
  ExperienceType,
  ProductCategory,
  ProductModel,
  ProductModelRepository,
  ProductRating,
  Review,
  ReviewLabel,
  ReviewLabelType,
  ReviewRepository,
  Sentiment,
} from "@ebike-backend/database";
import { DebugTraceService } from "@ebike-backend/debug";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { ProductRatingUpdaterService } from "./product-rating-updater.service";

let reviewCounter = 0;

function label(
  type: ReviewLabelType,
  text: string,
  sentiment: Sentiment,
  evidenceCount = 1,
): ReviewLabel {
  const entry = new ReviewLabel();
  entry.type = type;
  entry.label = text;
  entry.sentiment = sentiment;
  entry.evidenceCount = evidenceCount;
  return entry;
}

function makeReview(
  overrides: Partial<Review> & { labels?: ReviewLabel[] } = {},
): Review {
  const review = new Review();
  review.enabled = true;
  review.sentiment = overrides.sentiment ?? Sentiment.Neutral;
  review.reviewScore = overrides.reviewScore ?? 50;
  review.totalUpvotes = overrides.totalUpvotes ?? 0;
  review.totalDownvotes = overrides.totalDownvotes ?? 0;
  review.userId = overrides.userId ?? `user-${++reviewCounter}`;
  review.experience = overrides.experience ?? ExperienceType.Owner;
  review.labels = overrides.labels ?? [];
  return Object.assign(review, overrides);
}

function makeProduct(
  reviews: Review[],
  existingRating?: ProductRating,
  categorySlug?: string,
): ProductModel {
  const product = new ProductModel();
  product.reviews = reviews;
  product.rating = existingRating ?? null;
  if (categorySlug) {
    const category = new ProductCategory();
    category.slug = categorySlug;
    product.productCategory = category;
  }
  return product;
}

describe("ProductRatingUpdaterService", () => {
  let service: ProductRatingUpdaterService;
  let mockProductRepo: jest.Mocked<ProductModelRepository>;
  let mockReviewRepo: jest.Mocked<ReviewRepository>;
  let mockDynamicConfig: jest.Mocked<DynamicConfigService>;
  let mockDebugTrace: jest.Mocked<DebugTraceService>;

  beforeEach(() => {
    mockProductRepo = {
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ProductModelRepository>;

    mockReviewRepo = {
      deleteByIds: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ReviewRepository>;

    mockDynamicConfig = {
      rating: undefined,
      debug: undefined,
    } as unknown as jest.Mocked<DynamicConfigService>;

    mockDebugTrace = {} as unknown as jest.Mocked<DebugTraceService>;

    service = new ProductRatingUpdaterService(
      mockProductRepo,
      mockReviewRepo,
      mockDynamicConfig,
      mockDebugTrace,
    );
    reviewCounter = 0;
  });

  // ─── Basic Behavior ──────────────────────────────────────────────────────

  describe("basic behavior", () => {
    it("creates a new ProductRating when product has none", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating).toBeDefined();
      expect(product.rating).toBeInstanceOf(ProductRating);
    });

    it("saves the product after update", async () => {
      const product = makeProduct([makeReview()]);

      await service.updateProductRating(product);

      expect(mockProductRepo.save).toHaveBeenCalledWith(product);
    });

    it("reuses existing ProductRating", async () => {
      const existingRating = new ProductRating();
      existingRating.id = "existing-id";
      const product = makeProduct([makeReview()], existingRating);

      await service.updateProductRating(product);

      expect(product.rating).toBe(existingRating);
    });
  });

  // ─── Sentiment Counting ──────────────────────────────────────────────────

  describe("sentiment counting", () => {
    it("counts positive reviews", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive }),
        makeReview({ sentiment: Sentiment.Positive }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.positiveReviewCount).toBe(2);
      expect(product.rating!.strongPositiveReviewCount).toBe(0);
      expect(product.rating!.negativeReviewCount).toBe(0);
      expect(product.rating!.strongNegativeReviewCount).toBe(0);
      expect(product.rating!.neutralReviewCount).toBe(0);
      expect(product.rating!.mixedReviewCount).toBe(0);
    });

    it("counts StrongPositive and Positive in separate buckets", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.StrongPositive }),
        makeReview({ sentiment: Sentiment.Positive }),
        makeReview({ sentiment: Sentiment.Positive }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.strongPositiveReviewCount).toBe(1);
      expect(product.rating!.positiveReviewCount).toBe(2);
    });

    it("counts mixed reviews separately from neutral", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Mixed }),
        makeReview({ sentiment: Sentiment.Neutral }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.mixedReviewCount).toBe(1);
      expect(product.rating!.neutralReviewCount).toBe(1);
    });

    it("sets totalReviewCount to count of hands-on enabled reviews", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive }),
        makeReview({ sentiment: Sentiment.Negative }),
        makeReview({ sentiment: Sentiment.Neutral, enabled: false }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.totalReviewCount).toBe(2);
    });

    it("excludes disabled reviews from all counts", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive, enabled: false }),
        makeReview({ sentiment: Sentiment.Negative }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.positiveReviewCount).toBe(0);
      expect(product.rating!.negativeReviewCount).toBe(1);
      expect(product.rating!.totalReviewCount).toBe(1);
    });
  });

  // ─── Empty / No Enabled Reviews ──────────────────────────────────────────

  describe("no enabled reviews", () => {
    it("sets rating to null when no reviews exist", async () => {
      const product = makeProduct([]);

      await service.updateProductRating(product);

      expect(product.rating!.rating).toBeNull();
      expect(product.rating!.averageReviewScore).toBeNull();
    });

    it("excludes reviews below minReviewScore threshold", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive, reviewScore: 10 }),
        makeReview({ sentiment: Sentiment.Negative, reviewScore: 5 }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.rating).toBeNull();
      expect(product.rating!.totalReviewCount).toBe(0);
    });

    it("only includes reviews at or above minReviewScore threshold", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive, reviewScore: 50 }),
        makeReview({ sentiment: Sentiment.Negative, reviewScore: 10 }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.totalReviewCount).toBe(1);
      expect(product.rating!.positiveReviewCount).toBe(1);
      expect(product.rating!.negativeReviewCount).toBe(0);
    });
  });

  // ─── Average Review Score ────────────────────────────────────────────────

  describe("averageReviewScore", () => {
    it("averages reviewScore across enabled reviews", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive, reviewScore: 60 }),
        makeReview({ sentiment: Sentiment.Positive, reviewScore: 80 }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.averageReviewScore).toBe(70);
    });
  });

  // ─── Rating Formula ──────────────────────────────────────────────────────

  describe("rating formula", () => {
    it("produces high rating for all StrongPositive high-quality reviews", async () => {
      const product = makeProduct(
        Array.from({ length: 5 }, (_, i) =>
          makeReview({
            sentiment: Sentiment.StrongPositive,
            reviewScore: 60 + i * 5,
          }),
        ),
      );

      await service.updateProductRating(product);

      expect(product.rating!.rating).toBeGreaterThanOrEqual(75);
    });

    it("produces low rating for all StrongNegative high-quality reviews", async () => {
      const product = makeProduct(
        Array.from({ length: 5 }, (_, i) =>
          makeReview({
            sentiment: Sentiment.StrongNegative,
            reviewScore: 60 + i * 5,
          }),
        ),
      );

      await service.updateProductRating(product);

      expect(product.rating!.rating).toBeLessThanOrEqual(25);
    });

    it("weights upvoted positive reviews more than downvoted ones", async () => {
      const product = makeProduct([
        makeReview({
          sentiment: Sentiment.Positive,
          reviewScore: 50,
          totalUpvotes: 0,
          totalDownvotes: 10,
        }),
        makeReview({
          sentiment: Sentiment.Negative,
          reviewScore: 50,
          totalUpvotes: 10,
          totalDownvotes: 0,
        }),
      ]);

      await service.updateProductRating(product);

      // Upvoted negative should outweigh downvoted positive.
      expect(product.rating!.rating).toBeLessThan(50);
    });
  });

  // ─── Bayesian Dampening ──────────────────────────────────────────────────

  describe("bayesian dampening", () => {
    it("pulls single positive review toward neutral (50)", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive, reviewScore: 50 }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.rating).toBeLessThan(80);
      expect(product.rating!.rating).toBeGreaterThan(50);
    });

    it("pulls single negative review toward neutral (50)", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Negative, reviewScore: 50 }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.rating).toBeGreaterThan(20);
      expect(product.rating!.rating).toBeLessThan(50);
    });

    it("has less effect with more reviews", async () => {
      const singleReview = makeProduct([
        makeReview({ sentiment: Sentiment.Positive, reviewScore: 50 }),
      ]);

      const manyReviews = makeProduct(
        Array.from({ length: 10 }, () =>
          makeReview({ sentiment: Sentiment.Positive, reviewScore: 50 }),
        ),
      );

      await service.updateProductRating(singleReview);
      await service.updateProductRating(manyReviews);

      expect(manyReviews.rating!.rating).toBeGreaterThan(
        singleReview.rating!.rating!,
      );
    });
  });

  // ─── Feature Summary (label-driven Bayesian pro-share) ───────────────────

  describe("featureSummary", () => {
    it("emits one summary per feature label aggregated across reviews", async () => {
      const product = makeProduct([
        makeReview({
          userId: "u1",
          sentiment: Sentiment.Positive,
          labels: [label(ReviewLabelType.Feature, "HDR", Sentiment.Positive)],
        }),
        makeReview({
          userId: "u2",
          sentiment: Sentiment.Positive,
          labels: [
            label(ReviewLabelType.Feature, "HDR", Sentiment.StrongPositive),
          ],
        }),
        makeReview({
          userId: "u3",
          sentiment: Sentiment.Positive,
          labels: [label(ReviewLabelType.Feature, "HDR", Sentiment.Positive)],
        }),
      ]);

      await service.updateProductRating(product);

      const summaries = product.rating!.featureSummary!;
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe("HDR");
      expect(summaries[0].mentionCount).toBe(3);
      expect(summaries[0].strongPositiveCount).toBe(1);
      expect(summaries[0].positiveCount).toBe(2);
      expect(summaries[0].negativeCount).toBe(0);
      expect(summaries[0].score).toBeGreaterThanOrEqual(80);
    });

    it("counts each user once per label (dedups by userId, last-write-wins)", async () => {
      const product = makeProduct([
        makeReview({
          userId: "shared-user",
          sentiment: Sentiment.Positive,
          labels: [
            label(ReviewLabelType.Feature, "colors", Sentiment.Positive),
          ],
        }),
        // Same user with same label → same Set per sentiment bucket; size stays 1.
        makeReview({
          userId: "shared-user",
          sentiment: Sentiment.Positive,
          labels: [
            label(ReviewLabelType.Feature, "colors", Sentiment.Positive),
          ],
        }),
      ]);

      await service.updateProductRating(product);

      const summary = product.rating!.featureSummary!.find(
        (s) => s.name === "colors",
      )!;
      expect(summary.positiveCount).toBe(1);
      expect(summary.mentionCount).toBe(1);
    });

    it("separates positive and negative voices on the same label", async () => {
      const product = makeProduct([
        makeReview({
          userId: "u1",
          sentiment: Sentiment.Positive,
          labels: [label(ReviewLabelType.Feature, "VRR", Sentiment.Positive)],
        }),
        makeReview({
          userId: "u2",
          sentiment: Sentiment.Negative,
          labels: [label(ReviewLabelType.Feature, "VRR", Sentiment.Negative)],
        }),
        makeReview({
          userId: "u3",
          sentiment: Sentiment.Negative,
          labels: [
            label(ReviewLabelType.Feature, "VRR", Sentiment.StrongNegative),
          ],
        }),
      ]);

      await service.updateProductRating(product);

      const summary = product.rating!.featureSummary!.find(
        (s) => s.name === "VRR",
      )!;
      expect(summary.positiveCount).toBe(1);
      expect(summary.negativeCount).toBe(1);
      expect(summary.strongNegativeCount).toBe(1);
      // Bayesian pro-share: 1 pro vs 2 cons → score below 50.
      expect(summary.score).toBeLessThan(50);
    });

    it("returns null when no feature labels exist on any review", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive }),
        makeReview({ sentiment: Sentiment.Positive }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.featureSummary).toBeNull();
    });

    it("sorts feature summaries by mentionCount descending", async () => {
      const product = makeProduct([
        makeReview({
          userId: "u1",
          sentiment: Sentiment.Positive,
          labels: [
            label(ReviewLabelType.Feature, "HDR", Sentiment.Positive),
            label(ReviewLabelType.Feature, "colors", Sentiment.Positive),
          ],
        }),
        makeReview({
          userId: "u2",
          sentiment: Sentiment.Positive,
          labels: [label(ReviewLabelType.Feature, "HDR", Sentiment.Positive)],
        }),
        makeReview({
          userId: "u3",
          sentiment: Sentiment.Positive,
          labels: [label(ReviewLabelType.Feature, "HDR", Sentiment.Positive)],
        }),
      ]);

      await service.updateProductRating(product);

      const names = product.rating!.featureSummary!.map((s) => s.name);
      expect(names[0]).toBe("HDR");
      expect(names[1]).toBe("colors");
    });
  });

  // ─── Use Case Summary + useCaseScores map ────────────────────────────────

  describe("useCaseSummary and useCaseScores", () => {
    it("aggregates use cases and populates useCaseScores map", async () => {
      const product = makeProduct([
        makeReview({
          userId: "u1",
          sentiment: Sentiment.Positive,
          labels: [
            label(ReviewLabelType.UseCase, "pc gaming", Sentiment.Positive),
          ],
        }),
        makeReview({
          userId: "u2",
          sentiment: Sentiment.Positive,
          labels: [
            label(
              ReviewLabelType.UseCase,
              "pc gaming",
              Sentiment.StrongPositive,
            ),
          ],
        }),
      ]);

      await service.updateProductRating(product);

      const summaries = product.rating!.useCaseSummary!;
      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe("pc gaming");
      expect(product.rating!.useCaseScores).toEqual({
        "pc gaming": summaries[0].score,
      });
    });

    it("returns null useCaseScores when no use-case labels exist", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.useCaseSummary).toBeNull();
      expect(product.rating!.useCaseScores).toBeNull();
    });
  });

  // ─── Issue Summary (affected ratio scoring) ──────────────────────────────

  describe("issueSummary", () => {
    it("emits one summary per issue type with affected-ratio score", async () => {
      const product = makeProduct([
        makeReview({
          userId: "u1",
          sentiment: Sentiment.Negative,
          labels: [
            label(
              ReviewLabelType.Issue,
              "vrr black screen",
              Sentiment.Negative,
            ),
          ],
        }),
        makeReview({
          userId: "u2",
          sentiment: Sentiment.Negative,
          labels: [
            label(
              ReviewLabelType.Issue,
              "vrr black screen",
              Sentiment.StrongNegative,
            ),
          ],
        }),
        // 2 affected of 4 hands-on reviews → 50%
        makeReview({ userId: "u3", sentiment: Sentiment.Positive }),
        makeReview({ userId: "u4", sentiment: Sentiment.Positive }),
      ]);

      await service.updateProductRating(product);

      const issues = product.rating!.issueSummary!;
      expect(issues).toHaveLength(1);
      expect(issues[0].name).toBe("vrr black screen");
      expect(issues[0].mentionCount).toBe(2);
      expect(issues[0].score).toBe(50);
    });

    it("returns null when no issue labels exist on any review", async () => {
      const product = makeProduct([
        makeReview({ sentiment: Sentiment.Positive }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.issueSummary).toBeNull();
    });
  });

  // ─── Flat label score maps ──────────────────────────────────────────────

  describe("flat label score maps", () => {
    it("populates featureScores and issueScores in parallel with useCaseScores", async () => {
      const product = makeProduct([
        makeReview({
          sentiment: Sentiment.Positive,
          labels: [
            label(ReviewLabelType.UseCase, "gaming", Sentiment.Positive),
            label(
              ReviewLabelType.Feature,
              "motion clarity",
              Sentiment.Positive,
            ),
            label(ReviewLabelType.Issue, "ghosting", Sentiment.StrongNegative),
          ],
        }),
      ]);

      await service.updateProductRating(product);

      expect(product.rating!.useCaseScores).toEqual({
        gaming: expect.any(Number),
      });
      expect(product.rating!.featureScores).toEqual({
        "motion clarity": expect.any(Number),
      });
      expect(product.rating!.issueScores).toEqual({
        ghosting: expect.any(Number),
      });
    });
  });
});
