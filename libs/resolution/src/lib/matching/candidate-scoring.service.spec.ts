import { EvaluatedProduct } from "@ebike-backend/database";
import {
  ProductSimilarityService,
  ProductSimilarityResult,
} from "@ebike-backend/product";
import { CandidateScoringService } from "./candidate-scoring.service";

function makeCandidate(
  overrides: Partial<EvaluatedProduct> & { id: string },
): EvaluatedProduct {
  return {
    model: "TestModel",
    displayName: undefined,
    confidence: 0.9,
    specs: undefined,
    aliases: [],
    ...overrides,
  } as EvaluatedProduct;
}

function makeSimilarityResult(
  overrides: Partial<ProductSimilarityResult> = {},
): ProductSimilarityResult {
  return {
    score: 85,
    components: {
      stringSimilarity: 0.9,
      tokenOverlap: 0.8,
      alphaMatch: 1.0,
      aliasMatch: false,
      specSimilarity: 0,
    },
    bestMatchName: "testmodel",
    ...overrides,
  };
}

describe("CandidateScoringService", () => {
  let service: CandidateScoringService;
  let mockProductSimilarity: jest.Mocked<ProductSimilarityService>;

  beforeEach(() => {
    mockProductSimilarity = {
      score: jest.fn().mockReturnValue(makeSimilarityResult()),
    } as unknown as jest.Mocked<ProductSimilarityService>;

    service = new CandidateScoringService(mockProductSimilarity);
  });

  it("returns a match result per candidate", () => {
    const candidates = [
      makeCandidate({ id: "p1", model: "MPG341CQPX", confidence: 0.93 }),
      makeCandidate({ id: "p2", model: "MAG341CQP", confidence: 0.88 }),
    ];

    mockProductSimilarity.score
      .mockReturnValueOnce(
        makeSimilarityResult({ score: 95, bestMatchName: "mpg341cqpx" }),
      )
      .mockReturnValueOnce(
        makeSimilarityResult({ score: 55, bestMatchName: "mag341cqp" }),
      );

    const results = service.scoreAllCandidates(
      { model: "MPG341CQPX", brand: "MSI" },
      candidates,
      {},
      "monitors",
    );

    expect(results).toHaveLength(2);
    expect(results[0].candidateId).toBe("p1");
    expect(results[0].score).toBe(95);
    expect(results[0].alias).toBe("mpg341cqpx");
    expect(results[1].candidateId).toBe("p2");
    expect(results[1].score).toBe(55);
  });

  it("maps ProductSimilarityResult to MatchResult components", () => {
    const candidates = [makeCandidate({ id: "p1", confidence: 0.93 })];

    mockProductSimilarity.score.mockReturnValue(
      makeSimilarityResult({
        score: 85,
        components: {
          stringSimilarity: 0.85,
          tokenOverlap: 0.75,
          alphaMatch: 1.0,
          aliasMatch: false,
          specSimilarity: 0.5,
        },
      }),
    );

    const [result] = service.scoreAllCandidates(
      { model: "Test", brand: "Brand" },
      candidates,
      {},
    );

    expect(result.components.stringSimilarity).toBe(0.85);
    expect(result.components.tokenOverlap).toBe(0.75);
    expect(result.components.alphaMatch).toBe(1.0);
    expect(result.score).toBe(85);
  });

  it("skips candidates with no model or displayName", () => {
    const candidates = [
      makeCandidate({
        id: "p1",
        model: undefined as unknown as string,
        displayName: undefined,
      }),
    ];

    const results = service.scoreAllCandidates(
      { model: "Test" },
      candidates,
      {},
    );

    expect(results).toHaveLength(0);
  });

  it("skips candidates that score 0 with empty bestMatchName", () => {
    const candidates = [makeCandidate({ id: "p1" })];

    mockProductSimilarity.score.mockReturnValue(
      makeSimilarityResult({ score: 0, bestMatchName: "" }),
    );

    const results = service.scoreAllCandidates(
      { model: "Test" },
      candidates,
      {},
    );

    expect(results).toHaveLength(0);
  });

  it("passes input specs and category slug to ProductSimilarityService", () => {
    const candidates = [makeCandidate({ id: "p1", specs: { size: 27 } })];

    service.scoreAllCandidates(
      { model: "G27Q", brand: "Gigabyte", releaseYear: 2024 },
      candidates,
      { size: "27" },
      "monitors",
    );

    expect(mockProductSimilarity.score).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          model: "G27Q",
          specs: { size: "27" },
          year: 2024,
        }),
        candidate: expect.objectContaining({
          model: "TestModel",
          specs: { size: 27 },
        }),
        brandName: "Gigabyte",
        categorySlug: "monitors",
      }),
    );
  });
});
