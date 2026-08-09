import type {
  ProductModel,
  ProductModelRepository,
} from "@ebike-backend/database";
import { FinalizeService } from "./finalize.service";
import { makeTestContext } from "../testing/make-context";
import { ResolutionStatus } from "../models/resolution-status";

function makeRepo(
  byId: Record<string, ProductModel> = {},
  throws = false,
): ProductModelRepository {
  return {
    findByIdForPipeline: jest.fn().mockImplementation(async (id: string) => {
      if (throws) throw new Error("repo down");
      return byId[id] ?? null;
    }),
  } as unknown as ProductModelRepository;
}

function makeProductModel(id: string): ProductModel {
  return {
    id,
    model: "CANONICAL",
    brand: { name: "Samsung" },
    productCategory: { id: "c-monitors", name: "Monitor", slug: "monitors" },
    specs: { screenSize: '34"' },
  } as unknown as ProductModel;
}

describe("FinalizeService", () => {
  it("returns unresolved when no decision was made", async () => {
    const service = new FinalizeService(makeRepo());
    const context = makeTestContext();
    const result = await service.finalize(context);

    expect(result.resolvedModel).toBeUndefined();
    expect(result.confidence).toBe(0);
    expect(context.status).toBe(ResolutionStatus.UNRESOLVED);
  });

  it("returns unresolved on llm_unresolved decision", async () => {
    const service = new FinalizeService(makeRepo());
    const context = makeTestContext({
      decision: {
        kind: "llm_unresolved",
        confidence: 0,
        reason: "family_only_evidence",
        selectedCandidates: [],
      },
    });
    const result = await service.finalize(context);

    expect(result.resolvedModel).toBeUndefined();
    expect(context.status).toBe(ResolutionStatus.UNRESOLVED);
  });

  it("loads the resolved ProductModel from the primary pick on matcher_accept", async () => {
    const product = makeProductModel("p1");
    const repo = makeRepo({ p1: product });
    const service = new FinalizeService(repo);

    const context = makeTestContext({
      input: { model: "CANONICAL" },
      decision: {
        kind: "matcher_accept",
        confidence: 90,
        reason: "matcher_accept",
        selectedCandidates: [
          { candidateId: "p1", confidence: 90, reason: "matcher_accept_best" },
        ],
      },
    });
    const result = await service.finalize(context);

    expect(result.resolvedModel).toBe(product);
    expect(result.confidence).toBe(90);
    expect(context.status).toBe(ResolutionStatus.RESOLVED);
    expect(context.resolvedProduct?.id).toBe("p1");
  });

  it("uses the first entry of selectedCandidates as the primary on llm_resolved with multiple picks", async () => {
    const primary = makeProductModel("p1");
    const repo = makeRepo({ p1: primary, p2: makeProductModel("p2") });
    const service = new FinalizeService(repo);

    const context = makeTestContext({
      decision: {
        kind: "llm_resolved",
        confidence: 90,
        reason: "llm_resolved",
        selectedCandidates: [
          { candidateId: "p1", confidence: 90, reason: "NA variant" },
          { candidateId: "p2", confidence: 85, reason: "EU variant" },
        ],
      },
    });
    const result = await service.finalize(context);

    expect(result.resolvedModel).toBe(primary);
    expect(context.status).toBe(ResolutionStatus.RESOLVED);
  });

  it("records phase error and falls back to unresolved when the repo throws", async () => {
    const service = new FinalizeService(makeRepo({}, true));
    const context = makeTestContext({
      decision: {
        kind: "matcher_accept",
        confidence: 90,
        reason: "matcher_accept",
        selectedCandidates: [
          { candidateId: "p1", confidence: 90, reason: "matcher_accept_best" },
        ],
      },
    });
    const result = await service.finalize(context);

    expect(result.resolvedModel).toBeUndefined();
    expect(context.status).toBe(ResolutionStatus.UNRESOLVED);
    expect(context.errors[0].phase).toBe("finalize");
  });

  it("returns unresolved when the primary productId is not found in the repo", async () => {
    const service = new FinalizeService(makeRepo({}));
    const context = makeTestContext({
      decision: {
        kind: "matcher_accept",
        confidence: 90,
        reason: "matcher_accept",
        selectedCandidates: [
          {
            candidateId: "missing",
            confidence: 90,
            reason: "matcher_accept_best",
          },
        ],
      },
    });
    const result = await service.finalize(context);

    expect(result.resolvedModel).toBeUndefined();
    expect(context.status).toBe(ResolutionStatus.UNRESOLVED);
  });

  it("returns unresolved when selectedCandidates is empty (matcher_reject)", async () => {
    const service = new FinalizeService(makeRepo({}));
    const context = makeTestContext({
      decision: {
        kind: "matcher_reject",
        confidence: 0,
        reason: "no_candidates_above_threshold",
        selectedCandidates: [],
      },
    });
    const result = await service.finalize(context);

    expect(result.resolvedModel).toBeUndefined();
    expect(context.status).toBe(ResolutionStatus.UNRESOLVED);
  });
});
