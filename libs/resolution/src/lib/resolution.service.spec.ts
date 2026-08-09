import type { ProductModel } from "@ebike-backend/database";
import { ResolutionService } from "./resolution.service";
import type {
  ReferenceProductResolver,
  ReferenceResult,
} from "./stages/reference-product-resolver";
import type { BrandResolverService } from "./stages/brand-resolver.service";
import type { CategoryResolverService } from "./stages/category-resolver.service";
import type { RecallService } from "./stages/recall.service";
import type { FilterService } from "./stages/filter.service";
import type { ScoringService } from "./stages/scoring.service";
import type { DecisionService } from "./stages/decision.service";
import type { FinalizeService } from "./stages/finalize.service";
import { ResolutionStatus } from "./models/resolution-status";
import type {
  ResolutionContext,
  FinalDecision,
} from "./models/resolution-context";
import type { ResolutionResult } from "./models/resolution-result";

function makeReferenceResolver(
  result: ReferenceResult | null,
): ReferenceProductResolver {
  return {
    resolve: jest.fn().mockResolvedValue(result),
  } as unknown as ReferenceProductResolver;
}

function makeStage<T extends object>(
  name: keyof T,
  impl: jest.Mock = jest.fn(),
): T {
  return { [name]: impl } as unknown as T;
}

function makeFinalize(result: ResolutionResult): FinalizeService {
  return {
    finalize: jest
      .fn()
      .mockImplementation(async (context: ResolutionContext) => ({
        ...result,
        context,
      })),
  } as unknown as FinalizeService;
}

/**
 * Default recall mock: pushes 'fuzzy' to strategiesRun on the first call only.
 * Mimics a first-iteration recall that fires fuzzy; on the second iteration
 * (convergence check) it is a no-op and the loop exits.
 *
 * Tests that need richer per-iteration behavior should provide their own mock.
 */
function makeRecallServiceMock(): RecallService {
  return {
    recall: jest.fn().mockImplementation(async (ctx: ResolutionContext) => {
      if (ctx.strategiesRun.length === 0) {
        ctx.strategiesRun.push("fuzzy");
      }
    }),
  } as unknown as RecallService;
}

function makeReferenceProduct(): ProductModel {
  return {
    id: "ref-1",
    model: "S95D",
    brand: { name: "Samsung" },
    productCategory: { id: "c-monitors", name: "Monitor", slug: "monitors" },
    specs: { screenSize: '34"' },
  } as unknown as ProductModel;
}

describe("ResolutionService.search()", () => {
  it('short-circuits when reference-product resolver returns "resolved" (relation=same)', async () => {
    const reference = makeReferenceProduct();
    const brandResolver = makeStage<BrandResolverService>("resolve");
    const categoryResolver = makeStage<CategoryResolverService>("resolve");
    const recallService = makeStage<RecallService>("recall");
    const filterService = {
      filter: jest.fn(),
    } as unknown as FilterService;
    const scoringService = makeStage<ScoringService>("score");
    const decisionService = makeStage<DecisionService>("decide");
    const finalizeService = makeStage<FinalizeService>("finalize");

    const service = new ResolutionService(
      makeReferenceResolver({
        kind: "resolved",
        product: reference,
        confidence: 100,
        reason: "reference_same",
      }),
      brandResolver,
      categoryResolver,
      recallService,
      filterService,
      scoringService,
      decisionService,
      finalizeService,
    );

    const result = await service.search(
      { referenceProductId: "ref-1" },
      { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
    );

    expect(result.resolvedModel).toBe(reference);
    expect(result.confidence).toBe(100);
    expect(result.context.status).toBe(ResolutionStatus.RESOLVED);
    expect(result.context.decision?.kind).toBe("matcher_accept");
    expect(result.context.decision?.reason).toBe("reference_same");

    // Downstream stages must NOT have been called
    expect(brandResolver.resolve).not.toHaveBeenCalled();
    expect(categoryResolver.resolve).not.toHaveBeenCalled();
    expect(recallService.recall).not.toHaveBeenCalled();
    expect(filterService.filter).not.toHaveBeenCalled();
    expect(scoringService.score).not.toHaveBeenCalled();
    expect(decisionService.decide).not.toHaveBeenCalled();
    expect(finalizeService.finalize).not.toHaveBeenCalled();
  });

  it("runs the full pipeline when reference resolver returns reference_variant_search", async () => {
    const reference = makeReferenceProduct();
    const decision: FinalDecision = {
      kind: "llm_resolved",
      confidence: 80,
      reason: "llm_resolved",
      selectedCandidates: [
        { candidateId: "p1", confidence: 80, reason: "test" },
      ],
    };
    const finalResult: ResolutionResult = {
      resolvedModel: { id: "p1" } as ProductModel,
      context: {} as ResolutionContext,
      confidence: 80,
    };

    const brandResolver = makeStage<BrandResolverService>("resolve");
    const categoryResolver = makeStage<CategoryResolverService>("resolve");
    const recallService = makeRecallServiceMock();
    const filterService = {
      filter: jest.fn().mockReturnValue({
        qualifyingCandidates: [],
        outcome: { qualifyingCandidateIds: [], filteredCandidates: [] },
      }),
    } as unknown as FilterService;
    const scoringService = makeStage<ScoringService>("score");
    const decisionService = {
      decide: jest.fn().mockImplementation(async (ctx: ResolutionContext) => {
        ctx.decision = decision;
      }),
    } as unknown as DecisionService;
    const finalizeService = makeFinalize(finalResult);

    const service = new ResolutionService(
      makeReferenceResolver({
        kind: "reference_variant_search",
        product: reference,
      }),
      brandResolver,
      categoryResolver,
      recallService,
      filterService,
      scoringService,
      decisionService,
      finalizeService,
    );

    const result = await service.search(
      { referenceProductId: "ref-1", modelClues: ["G85SD"] },
      { useEmbedding: true, webSearchEnabled: true, mode: "loose" },
    );

    expect(brandResolver.resolve).toHaveBeenCalled();
    expect(categoryResolver.resolve).toHaveBeenCalled();
    expect(recallService.recall).toHaveBeenCalled();
    expect(filterService.filter).toHaveBeenCalled();
    expect(scoringService.score).toHaveBeenCalled();
    expect(decisionService.decide).toHaveBeenCalled();
    expect(finalizeService.finalize).toHaveBeenCalled();
    expect(result.resolvedModel?.id).toBe("p1");
  });

  it("runs the full pipeline when reference resolver returns null (no reference)", async () => {
    const decision: FinalDecision = {
      kind: "matcher_accept",
      confidence: 90,
      reason: "matcher_accept",
      selectedCandidates: [
        { candidateId: "p1", confidence: 80, reason: "test" },
      ],
    };
    const finalResult: ResolutionResult = {
      resolvedModel: { id: "p1" } as ProductModel,
      context: {} as ResolutionContext,
      confidence: 90,
    };

    const brandResolver = makeStage<BrandResolverService>("resolve");
    const categoryResolver = makeStage<CategoryResolverService>("resolve");
    const recallService = makeRecallServiceMock();
    const filterService = {
      filter: jest.fn().mockReturnValue({
        qualifyingCandidates: [],
        outcome: { qualifyingCandidateIds: [], filteredCandidates: [] },
      }),
    } as unknown as FilterService;
    const scoringService = makeStage<ScoringService>("score");
    const decisionService = {
      decide: jest.fn().mockImplementation(async (ctx: ResolutionContext) => {
        ctx.decision = decision;
      }),
    } as unknown as DecisionService;
    const finalizeService = makeFinalize(finalResult);

    const service = new ResolutionService(
      makeReferenceResolver(null),
      brandResolver,
      categoryResolver,
      recallService,
      filterService,
      scoringService,
      decisionService,
      finalizeService,
    );

    const result = await service.search(
      { brand: "Samsung", model: "G85SD" },
      { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
    );

    expect(brandResolver.resolve).toHaveBeenCalled();
    expect(filterService.filter).toHaveBeenCalled();
    expect(result.resolvedModel?.id).toBe("p1");
  });

  it("passes callerContext.threadContext through to decisionService", async () => {
    const decision: FinalDecision = {
      kind: "llm_resolved",
      confidence: 80,
      reason: "llm_resolved",
      selectedCandidates: [
        { candidateId: "p1", confidence: 80, reason: "test" },
      ],
    };
    const finalResult: ResolutionResult = {
      resolvedModel: { id: "p1" } as ProductModel,
      context: {} as ResolutionContext,
      confidence: 80,
    };

    const decideMock = jest
      .fn()
      .mockImplementation(async (ctx: ResolutionContext) => {
        ctx.decision = decision;
      });
    const service = new ResolutionService(
      makeReferenceResolver(null),
      makeStage<BrandResolverService>("resolve"),
      makeStage<CategoryResolverService>("resolve"),
      makeStage<RecallService>("recall"),
      {
        filter: jest.fn().mockReturnValue({
          qualifyingCandidates: [],
          outcome: { qualifyingCandidateIds: [], filteredCandidates: [] },
        }),
      } as unknown as FilterService,
      makeStage<ScoringService>("score"),
      { decide: decideMock } as unknown as DecisionService,
      makeFinalize(finalResult),
    );

    await service.search(
      { brand: "Samsung", model: "G85SD" },
      { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
      { threadContext: { threadTitle: "T", subreddit: "S" } },
    );

    expect(decideMock).toHaveBeenCalledWith(
      expect.anything(),
      { threadTitle: "T", subreddit: "S" },
      undefined,
      undefined,
    );
  });

  describe("recall fixed-point loop", () => {
    /**
     * Harness that drives the fixed-point loop with stage doubles.
     *
     * `recall` mock conditions on what's already in `ctx.strategiesRun`:
     *  - First call (empty): mimics the first-iteration outcome — sets
     *    candidates from `candidatesAfterFirstRecall` and pushes the
     *    `strategiesRunAfterFirst` names.
     *  - Second call (fuzzy/embedding/web already present): if
     *    `candidatesAfterRescue` is set, mimics the rescue iteration —
     *    widens candidates and pushes `embedding`.
     *  - Otherwise no-op: no strategy fires, loop converges.
     *
     * `score` mock returns `scoringAfterFirst` on the first call and
     * `scoringAfterRescue` on every subsequent call (so rescue iterations
     * see the post-rescue scoring snapshot).
     */
    function makeLoopHarness(opts: {
      candidatesAfterFirstRecall: string[];
      scoringAfterFirst: ResolutionContext["scoring"];
      candidatesAfterRescue?: string[];
      scoringAfterRescue?: ResolutionContext["scoring"];
      strategiesRunAfterFirst?: Array<"fuzzy" | "embedding" | "web">;
    }) {
      const recallMock = jest
        .fn()
        .mockImplementation(async (ctx: ResolutionContext) => {
          // First iteration — strategiesRun is empty.
          if (ctx.strategiesRun.length === 0) {
            ctx.candidates = opts.candidatesAfterFirstRecall.map((id) => ({
              productId: id,
              source: "fuzzy" as const,
            }));
            for (const name of opts.strategiesRunAfterFirst ?? ["fuzzy"]) {
              ctx.strategiesRun.push(name);
            }
            return;
          }
          // Subsequent iteration — fire embedding rescue if configured and not
          // already in strategiesRun. Otherwise converge (no-op).
          if (
            opts.candidatesAfterRescue &&
            !ctx.strategiesRun.includes("embedding")
          ) {
            ctx.candidates = opts.candidatesAfterRescue.map((id) => ({
              productId: id,
              source: "embedding" as const,
            }));
            ctx.strategiesRun.push("embedding");
          }
        });

      const filterMock = jest
        .fn()
        .mockImplementation((ctx: ResolutionContext) => ({
          qualifyingCandidates: ctx.candidates,
          outcome: {
            qualifyingCandidateIds: ctx.candidates.map((c) => c.productId),
            filteredCandidates: [],
          },
        }));

      let scoreCallIndex = 0;
      const scoreMock = jest
        .fn()
        .mockImplementation((ctx: ResolutionContext) => {
          const isRescuedCall = scoreCallIndex > 0;
          scoreCallIndex += 1;
          ctx.scoring = isRescuedCall
            ? (opts.scoringAfterRescue ?? { failedGates: [] })
            : opts.scoringAfterFirst;
        });

      const decideMock = jest
        .fn()
        .mockImplementation(async (ctx: ResolutionContext) => {
          ctx.decision = {
            kind: "llm_unresolved",
            confidence: 0,
            reason: "no_qualifying_candidates",
            selectedCandidates: [],
          };
        });

      const finalResult: ResolutionResult = {
        resolvedModel: undefined as unknown as ProductModel,
        context: {} as ResolutionContext,
        confidence: 0,
      };

      const service = new ResolutionService(
        makeReferenceResolver(null),
        makeStage<BrandResolverService>("resolve"),
        makeStage<CategoryResolverService>("resolve"),
        { recall: recallMock } as unknown as RecallService,
        { filter: filterMock } as unknown as FilterService,
        { score: scoreMock } as unknown as ScoringService,
        { decide: decideMock } as unknown as DecisionService,
        makeFinalize(finalResult),
      );

      return { service, recallMock, filterMock, scoreMock, decideMock };
    }

    it("converges after one iteration when first scoring accepted", async () => {
      const harness = makeLoopHarness({
        candidatesAfterFirstRecall: ["p1"],
        scoringAfterFirst: {
          bestCandidate: { candidateId: "p1", alias: "p1", score: 95 },
          failedGates: [],
        },
      });

      await harness.service.search(
        { brand: "MSI", model: "MPG341CQPX" },
        { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
      );

      // 2 recall calls: one that fires fuzzy, one that converges (no-op).
      expect(harness.recallMock).toHaveBeenCalledTimes(2);
      expect(harness.scoreMock).toHaveBeenCalledTimes(1);
      expect(harness.filterMock).toHaveBeenCalledTimes(1);
    });

    it("rescues when first scoring failed gates — second iteration fires embedding", async () => {
      const harness = makeLoopHarness({
        candidatesAfterFirstRecall: ["p1"],
        scoringAfterFirst: {
          bestCandidate: { candidateId: "p1", alias: "p1", score: 30 },
          failedGates: ["low_confidence_anchored"],
        },
        candidatesAfterRescue: ["p2"],
        scoringAfterRescue: {
          bestCandidate: { candidateId: "p2", alias: "p2", score: 92 },
          failedGates: [],
        },
      });

      await harness.service.search(
        { brand: "MSI", model: "MPG341CQPX" },
        { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
      );

      // 3 recall calls: fuzzy, embedding rescue, convergence (no-op).
      expect(harness.recallMock).toHaveBeenCalledTimes(3);
      expect(harness.scoreMock).toHaveBeenCalledTimes(2);
      expect(harness.filterMock).toHaveBeenCalledTimes(2);
    });

    it("rescues when first pass yields no candidates", async () => {
      const harness = makeLoopHarness({
        candidatesAfterFirstRecall: [],
        scoringAfterFirst: { failedGates: [] },
        candidatesAfterRescue: ["p2"],
        scoringAfterRescue: {
          bestCandidate: { candidateId: "p2", alias: "p2", score: 88 },
          failedGates: [],
        },
      });

      await harness.service.search(
        { brand: "MSI", model: "MPG341CQPX" },
        { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
      );

      expect(harness.recallMock).toHaveBeenCalledTimes(3);
      expect(harness.scoreMock).toHaveBeenCalledTimes(2);
    });

    it("rescue still fails — loop terminates and decision LLM runs", async () => {
      const harness = makeLoopHarness({
        candidatesAfterFirstRecall: ["p1"],
        scoringAfterFirst: {
          bestCandidate: { candidateId: "p1", alias: "p1", score: 30 },
          failedGates: ["low_confidence_anchored"],
        },
        candidatesAfterRescue: ["p1", "p2"],
        scoringAfterRescue: {
          bestCandidate: { candidateId: "p2", alias: "p2", score: 45 },
          failedGates: ["low_confidence_anchored"],
        },
      });

      await harness.service.search(
        { brand: "MSI", model: "MPG341CQPX" },
        { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
      );

      // 3 recall calls — embedding rescue won't fire a second time because
      // 'embedding' is in strategiesRun. Loop terminates.
      expect(harness.recallMock).toHaveBeenCalledTimes(3);
      expect(harness.decideMock).toHaveBeenCalledTimes(1);
    });

    it("loop terminates when no strategy fires on iteration 1", async () => {
      // Empty harness: every recall call is a no-op (no strategies push to
      // strategiesRun). Loop should converge after the first recall call.
      const recallMock = jest.fn().mockResolvedValue(undefined);
      const filterMock = jest.fn().mockReturnValue({
        qualifyingCandidates: [],
        outcome: { qualifyingCandidateIds: [], filteredCandidates: [] },
      });
      const scoreMock = jest.fn();
      const decideMock = jest
        .fn()
        .mockImplementation(async (ctx: ResolutionContext) => {
          ctx.decision = {
            kind: "llm_unresolved",
            confidence: 0,
            reason: "no_qualifying_candidates",
            selectedCandidates: [],
          };
        });

      const service = new ResolutionService(
        makeReferenceResolver(null),
        makeStage<BrandResolverService>("resolve"),
        makeStage<CategoryResolverService>("resolve"),
        { recall: recallMock } as unknown as RecallService,
        { filter: filterMock } as unknown as FilterService,
        { score: scoreMock } as unknown as ScoringService,
        { decide: decideMock } as unknown as DecisionService,
        makeFinalize({
          resolvedModel: undefined as unknown as ProductModel,
          context: {} as ResolutionContext,
          confidence: 0,
        }),
      );

      await service.search(
        { brand: "MSI", model: "MPG341CQPX" },
        { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
      );

      expect(recallMock).toHaveBeenCalledTimes(1);
      expect(filterMock).not.toHaveBeenCalled();
      expect(scoreMock).not.toHaveBeenCalled();
    });

    it("hits safety cap and pushes phase error when a strategy never converges", async () => {
      // Pathological recall: pushes a new entry to strategiesRun on every call.
      const recallMock = jest
        .fn()
        .mockImplementation(async (ctx: ResolutionContext) => {
          ctx.strategiesRun.push("fuzzy");
        });
      const filterMock = jest.fn().mockReturnValue({
        qualifyingCandidates: [],
        outcome: { qualifyingCandidateIds: [], filteredCandidates: [] },
      });
      const scoreMock = jest.fn();
      const decideMock = jest
        .fn()
        .mockImplementation(async (ctx: ResolutionContext) => {
          ctx.decision = {
            kind: "llm_unresolved",
            confidence: 0,
            reason: "no_qualifying_candidates",
            selectedCandidates: [],
          };
        });

      const service = new ResolutionService(
        makeReferenceResolver(null),
        makeStage<BrandResolverService>("resolve"),
        makeStage<CategoryResolverService>("resolve"),
        { recall: recallMock } as unknown as RecallService,
        { filter: filterMock } as unknown as FilterService,
        { score: scoreMock } as unknown as ScoringService,
        { decide: decideMock } as unknown as DecisionService,
        makeFinalize({
          resolvedModel: undefined as unknown as ProductModel,
          context: {} as ResolutionContext,
          confidence: 0,
        }),
      );

      const result = await service.search(
        { brand: "MSI", model: "MPG341CQPX" },
        { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
      );

      // Cap is 10 — recall called exactly 10 times before the loop exits.
      expect(recallMock).toHaveBeenCalledTimes(10);
      const recallErrors = result.context.errors.filter(
        (e) => e.phase === "recall",
      );
      expect(recallErrors).toHaveLength(1);
      expect(recallErrors[0].message).toContain("max iterations");
    });
  });

  it("writes totals.durationMs on the returned context", async () => {
    const reference = makeReferenceProduct();
    const service = new ResolutionService(
      makeReferenceResolver({
        kind: "resolved",
        product: reference,
        confidence: 100,
        reason: "reference_same",
      }),
      makeStage<BrandResolverService>("resolve"),
      makeStage<CategoryResolverService>("resolve"),
      makeStage<RecallService>("recall"),
      { filter: jest.fn() } as unknown as FilterService,
      makeStage<ScoringService>("score"),
      makeStage<DecisionService>("decide"),
      makeStage<FinalizeService>("finalize"),
    );

    const result = await service.search(
      { referenceProductId: "ref-1" },
      { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
    );

    expect(result.context.totals.durationMs).toBeGreaterThanOrEqual(0);
  });
});
