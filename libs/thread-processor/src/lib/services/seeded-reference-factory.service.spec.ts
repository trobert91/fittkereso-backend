import {
  ProductModel,
  ProductReference,
  ProductReferenceCandidate,
  UserComment,
} from "@ebike-backend/database";
import {
  ResolutionResult,
  ResolutionResultApplierService,
  ResolutionStatus,
  ResolutionRegistryUpdater,
} from "@ebike-backend/resolution";
import { HeldResolution } from "../models/discovered-product.model";
import {
  ReferenceSeed,
  SeededReferenceFactory,
} from "./seeded-reference-factory.service";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeModel(id: string, model: string): ProductModel {
  const m = new ProductModel();
  m.id = id;
  m.model = model;
  m.displayName = `Brand ${model}`;
  return m;
}

function makeComment(body: string): UserComment {
  const comment = new UserComment();
  comment.id = "comment-1";
  comment.body = body;
  comment.externalCreationTs = new Date("2024-01-01T00:00:00Z");
  return comment;
}

function makeSeed(overrides?: Partial<ReferenceSeed>): ReferenceSeed {
  return {
    type: "explicit",
    brand: "Brand",
    model: "X34",
    specs: [{ name: "screenSize", value: '34"' }],
    categoryHint: "monitor",
    contentQuality: "high",
    productLinkId: "link-A",
    productLinkLabel: "A",
    registryKey: "brand::x34",
    ...overrides,
  };
}

/**
 * Build a held resolution whose decision selects `modelIds` as candidates — the
 * shape a real search produces. The applier reads `selectedCandidates` to
 * rebuild the candidate set, so this is what drives ambiguity.
 */
function makeHeldResolution(modelIds: string[]): HeldResolution {
  const result: ResolutionResult = {
    resolvedModel: makeModel(modelIds[0], "X34"),
    confidence: 90,
    context: {
      input: { brand: "Brand", model: "X34" },
      options: { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
      modelVariants: [],
      searchedKeywords: [],
      searchEvidence: [],
      candidates: [],
      strategiesRun: [],
      status: ResolutionStatus.RESOLVED,
      decision: {
        kind: "matcher_accept",
        confidence: 90,
        reason: "matcher_accept",
        selectedCandidates: modelIds.map((id, index) => ({
          candidateId: id,
          confidence: 90 - index * 5,
          reason: "matcher_accept",
        })),
      },
      totals: { durationMs: 1, cost: 0, llmCalls: 0, webSearchCalls: 0 },
      errors: [],
    },
  };
  return { result, resolved: true };
}

// ─── Applier with mocked repos ───────────────────────────────────────────────

function makeApplier(models: ProductModel[]): ResolutionResultApplierService {
  const modelById = new Map(models.map((m) => [m.id, m]));
  const candidateRepository = {
    repo: {
      delete: jest.fn(async () => undefined),
      // Mimic save: assign ids, preserve order (primary-first guaranteed by applier).
      save: jest.fn(async (candidates: ProductReferenceCandidate[]) =>
        candidates.map((candidate, index) => {
          candidate.id = `cand-${index}`;
          return candidate;
        }),
      ),
    },
  };
  const productModelRepository = {
    repo: {
      // The applier filters by the candidateIds it requested, so returning the
      // full known set is safe and avoids depending on TypeORM FindOperator
      // internals in the mock.
      find: jest.fn(async () => [...modelById.values()]),
    },
  };
  return new ResolutionResultApplierService(
    candidateRepository as never,
    productModelRepository as never,
  );
}

function makeRegistryUpdater(): ResolutionRegistryUpdater {
  return {
    syncFromReference: jest.fn(),
  } as unknown as ResolutionRegistryUpdater;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SeededReferenceFactory", () => {
  describe("buildReference", () => {
    it("reproduces the full identification snapshot and leaves candidates empty", () => {
      const factory = new SeededReferenceFactory(makeApplier([]));
      const comment = makeComment("great monitor");
      const seed = makeSeed({
        referenceModel: "34GS95QE-B",
        modelClues: ["G8sd"],
        variantClues: ["black remote"],
      });

      const ref = factory.buildReference(comment, seed);

      const identification = ref.context.identification;
      expect(identification.type).toBe("explicit");
      expect(identification.brand).toBe("Brand");
      expect(identification.model).toBe("X34");
      expect(identification.displayName).toBe("Brand X34");
      expect(identification.registryKey).toBe("brand::x34");
      expect(identification.categoryHint).toBe("monitor");
      expect(identification.categories).toEqual(["monitor"]);
      expect(identification.contentQuality).toBe("high");
      expect(identification.referenceModel).toBe("34GS95QE-B");
      expect(identification.modelClues).toEqual(["G8sd"]);
      expect(identification.variantClues).toEqual(["black remote"]);
      expect(identification.productLinkLabel).toBe("A");
      expect(identification.searchBefore).toEqual(comment.externalCreationTs);
      // Specs land on both context.identification and the ref column.
      expect(identification.specs).toEqual([
        { name: "screenSize", value: '34"' },
      ]);
      expect(ref.specs).toEqual([{ name: "screenSize", value: '34"' }]);
      // Born-unresolved until seeded.
      expect(ref.candidates).toEqual([]);
      expect(ref.ambiguousResolution).toBe(false);
      expect(ref.resolutionFinished).toBe(false);
      expect(ref.productLinkId).toBe("link-A");
      expect(ref.enabled).toBe(true);
    });
  });

  describe("seedResolution — born resolved", () => {
    it("seeds a single-candidate resolution as a non-ambiguous full bundle", async () => {
      const factory = new SeededReferenceFactory(
        makeApplier([makeModel("m1", "X34")]),
      );
      const comment = makeComment("great monitor");
      const ref = factory.buildReference(comment, makeSeed());
      ref.id = "ref-1"; // coordinator saved it before seeding (FK → ref.id)

      const held = makeHeldResolution(["m1"]);
      await factory.seedResolution(
        ref,
        held,
        comment.body,
        makeRegistryUpdater(),
      );

      expect(ref.candidates ?? []).toHaveLength(1);
      expect((ref.candidates ?? [])[0]?.isPrimary).toBe(true);
      expect(ref.ambiguousResolution).toBe(false);
      expect(ref.resolutionFinished).toBe(true);
      expect(ref.resolutionLastAttemptedAt).toBeInstanceOf(Date);
      // searchContext carries the input for backfill/re-resolution.
      expect(ref.searchContext?.input).toEqual({
        brand: "Brand",
        model: "X34",
      });
    });

    it("preserves the FULL ambiguous candidate set across N comments mapping to one product", async () => {
      const models = [makeModel("m1", "X34"), makeModel("m2", "X34-Pro")];
      const factory = new SeededReferenceFactory(makeApplier(models));

      // One held result shared by three comments mapping to the same ambiguous product.
      const held = makeHeldResolution(["m1", "m2"]);

      const refs: ProductReference[] = [];
      for (let i = 0; i < 3; i++) {
        const comment = makeComment(`comment ${i}`);
        comment.id = `comment-${i}`;
        const ref = factory.buildReference(comment, makeSeed());
        ref.id = `ref-${i}`;
        await factory.seedResolution(
          ref,
          held,
          comment.body,
          makeRegistryUpdater(),
        );
        refs.push(ref);
      }

      for (const ref of refs) {
        // Full multi-candidate set on every ref — never flattened to primary.
        const candidates = ref.candidates ?? [];
        expect(candidates).toHaveLength(2);
        expect(ref.ambiguousResolution).toBe(true);
        expect(candidates.filter((c) => c.isPrimary)).toHaveLength(1);
        expect(ref.resolutionFinished).toBe(true);
        expect(ref.searchContext?.input).toEqual({
          brand: "Brand",
          model: "X34",
        });
      }

      // Each ref owns a DISTINCT cloned searchContext — mutating one must not
      // leak into siblings (the aliasing guard).
      expect(refs[0].searchContext).not.toBe(refs[1].searchContext);
      (refs[0].searchContext as { status: string }).status = "MUTATED";
      expect(refs[1].searchContext?.status).toBe(ResolutionStatus.RESOLVED);
      // …and not the shared held result either.
      expect(refs[0].searchContext).not.toBe(held.result?.context);
    });
  });

  describe("seedResolution — deferred", () => {
    it("no-ops for a deferred (null-result) held resolution", async () => {
      const factory = new SeededReferenceFactory(makeApplier([]));
      const ref = factory.buildReference(makeComment("x"), makeSeed());
      ref.id = "ref-1";

      const deferred: HeldResolution = { result: null, resolved: false };
      await factory.seedResolution(ref, deferred, "x", makeRegistryUpdater());

      expect(ref.candidates).toEqual([]);
      expect(ref.resolutionFinished).toBe(false);
      expect(ref.searchContext).toBeUndefined();
    });
  });
});
