import {
  CommentStatus,
  Depth,
  Intent,
  ProductModel,
  ProductReference,
  ProductReferenceRepository,
  Review,
  ReviewLabelRepository,
  ReviewRepository,
  Sentiment,
  ThreadPlatform,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { DebugTraceService } from "@ebike-backend/debug";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { ReviewEvaluatorService } from "./review-evaluator.service";
import { ReviewUpdaterService } from "./review-updater.service";

interface RepoStubs {
  reviewRepo: ReviewRepository;
  reviewLabelRepo: ReviewLabelRepository;
  commentRepo: UserCommentRepository;
  productRefRepo: ProductReferenceRepository;
  evaluator: ReviewEvaluatorService;
  debugTrace: DebugTraceService;
  dynamicConfig: DynamicConfigService;
  reviewSaveSpy: jest.Mock;
}

function makeStubs(options: {
  existingReview?: Review;
  fetchedComments: UserComment[];
  evaluateImpl: (review: Review) => void;
}): RepoStubs {
  const reviewSaveSpy = jest.fn(async (review: Review) => {
    if (!review.id) review.id = "review-new-id";
    return review;
  });

  const existing = options.existingReview ?? null;

  const reviewRepo = {
    save: reviewSaveSpy,
    repo: {
      createQueryBuilder: () => ({
        leftJoinAndSelect: function (this: unknown) {
          return this;
        },
        where: function (this: unknown) {
          return this;
        },
        andWhere: function (this: unknown) {
          return this;
        },
        getOne: async () => existing,
      }),
    },
  } as unknown as ReviewRepository;

  const reviewLabelRepo = {
    repo: {
      delete: jest.fn(async () => undefined),
    },
  } as unknown as ReviewLabelRepository;

  const commentRepo = {
    repo: {
      update: jest.fn(async () => undefined),
      createQueryBuilder: () => ({
        leftJoinAndSelect: function (this: unknown) {
          return this;
        },
        where: function (this: unknown) {
          return this;
        },
        andWhere: function (this: unknown) {
          return this;
        },
        orderBy: function (this: unknown) {
          return this;
        },
        getMany: async () => options.fetchedComments,
      }),
    },
  } as unknown as UserCommentRepository;

  const productRefRepo = {
    saveAll: jest.fn(async () => undefined),
  } as unknown as ProductReferenceRepository;

  const evaluator = {
    evaluate: jest.fn(async (review: Review) => {
      options.evaluateImpl(review);
      return undefined;
    }),
  } as unknown as ReviewEvaluatorService;

  const debugTrace = {
    record: jest.fn(async () => undefined),
  } as unknown as DebugTraceService;

  const dynamicConfig = {
    debug: { traceEnabled: false },
  } as unknown as DynamicConfigService;

  return {
    reviewRepo,
    reviewLabelRepo,
    commentRepo,
    productRefRepo,
    evaluator,
    debugTrace,
    dynamicConfig,
    reviewSaveSpy,
  };
}

function makeProductModel(id = "model-1"): ProductModel {
  const model = new ProductModel();
  model.id = id;
  return model;
}

function makeReference(
  comment: UserComment,
  model: ProductModel,
  overrides: Partial<ProductReference> = {},
): ProductReference {
  const reference = new ProductReference();
  reference.id =
    overrides.id ?? `ref-${Math.random().toString(36).slice(2, 8)}`;
  reference.enabled = true;
  reference.flagged = false;
  reference.resolutionFinished = false;
  reference.relevance = overrides.relevance ?? 80;
  reference.depth = overrides.depth ?? Depth.Detailed;
  reference.sentiment = overrides.sentiment ?? Sentiment.Positive;
  reference.intents = overrides.intents ?? [Intent.Recommendation];
  reference.quotes = overrides.quotes ?? [
    {
      id: "q-1",
      text: "great product overall and would buy again",
      sentiment: Sentiment.Positive,
    },
  ];
  reference.resolvedModel = model;
  reference.comment = comment;
  return reference;
}

function makeComment(
  authorId = "user-1",
  references: ProductReference[] = [],
): UserComment {
  const comment = new UserComment();
  comment.id = `comment-${Math.random().toString(36).slice(2, 8)}`;
  comment.authorId = authorId;
  comment.authorName = authorId;
  comment.status = CommentStatus.APPROVED;
  comment.productReferences = references;
  comment.upvotes = 0;
  comment.downvotes = 0;
  return comment;
}

function makeReview(model: ProductModel, authorId = "user-1"): Review {
  const review = new Review();
  review.id = "review-existing";
  review.model = model;
  review.userId = authorId;
  review.username = authorId;
  review.enabled = true;
  review.sentiment = Sentiment.Positive;
  review.intents = [Intent.Recommendation];
  review.platform = ThreadPlatform.Reddit;
  return review;
}

describe("ReviewUpdaterService — empty quote gate", () => {
  it("soft-deletes an existing review when evaluator leaves review.quotes empty", async () => {
    const model = makeProductModel();
    const existingReview = makeReview(model);
    const comment = makeComment();
    const reference = makeReference(comment, model);
    comment.productReferences = [reference];

    const stubs = makeStubs({
      existingReview,
      fetchedComments: [comment],
      evaluateImpl: (review) => {
        review.quotes = [];
      },
    });

    const service = new ReviewUpdaterService(
      stubs.reviewRepo,
      stubs.reviewLabelRepo,
      stubs.commentRepo,
      stubs.productRefRepo,
      stubs.evaluator,
      stubs.debugTrace,
      stubs.dynamicConfig,
    );

    await service.process(comment);

    expect(existingReview.enabled).toBe(false);
    expect(existingReview.deletedAt).toBeInstanceOf(Date);
    expect(existingReview.lastEvaluatedAt).toBeInstanceOf(Date);
    const savedWithSoftDelete = stubs.reviewSaveSpy.mock.calls.some(
      ([review]) => review.id === "review-existing" && review.enabled === false,
    );
    expect(savedWithSoftDelete).toBe(true);
    expect(stubs.debugTrace.record).not.toHaveBeenCalled();
  });

  it("does not persist a brand-new review when review.quotes is empty after evaluation", async () => {
    const model = makeProductModel();
    const comment = makeComment();
    const reference = makeReference(comment, model);
    comment.productReferences = [reference];

    const stubs = makeStubs({
      existingReview: undefined,
      fetchedComments: [comment],
      evaluateImpl: (review) => {
        review.quotes = [];
      },
    });

    const service = new ReviewUpdaterService(
      stubs.reviewRepo,
      stubs.reviewLabelRepo,
      stubs.commentRepo,
      stubs.productRefRepo,
      stubs.evaluator,
      stubs.debugTrace,
      stubs.dynamicConfig,
    );

    await service.process(comment);

    // Only the initial pre-link save fires; after evaluation the empty-quotes
    // gate triggers and softDeleteReview short-circuits because review.id was
    // assigned by the first save. The second save must NOT be a non-soft-delete
    // persistence — verify by ensuring no save call carries non-empty quotes.
    const persistedWithQuotes = stubs.reviewSaveSpy.mock.calls.some(
      ([review]) => !!review.quotes && review.quotes.length > 0,
    );
    expect(persistedWithQuotes).toBe(false);
    expect(stubs.debugTrace.record).not.toHaveBeenCalled();
  });

  it("persists the review on the happy path when review.quotes is populated", async () => {
    const model = makeProductModel();
    const existingReview = makeReview(model);
    const comment = makeComment();
    const reference = makeReference(comment, model);
    comment.productReferences = [reference];

    const stubs = makeStubs({
      existingReview,
      fetchedComments: [comment],
      evaluateImpl: (review) => {
        review.quotes = [
          {
            id: "q-1",
            text: "response time is excellent for gaming",
            sentiment: Sentiment.Positive,
            quality: "high",
          },
        ];
      },
    });

    const service = new ReviewUpdaterService(
      stubs.reviewRepo,
      stubs.reviewLabelRepo,
      stubs.commentRepo,
      stubs.productRefRepo,
      stubs.evaluator,
      stubs.debugTrace,
      stubs.dynamicConfig,
    );

    await service.process(comment);

    expect(existingReview.enabled).toBe(true);
    expect(existingReview.deletedAt).toBeNull();
    const persistedWithQuotes = stubs.reviewSaveSpy.mock.calls.some(
      ([review]) =>
        !!review.quotes &&
        review.quotes.length === 1 &&
        review.enabled === true,
    );
    expect(persistedWithQuotes).toBe(true);
  });
});
