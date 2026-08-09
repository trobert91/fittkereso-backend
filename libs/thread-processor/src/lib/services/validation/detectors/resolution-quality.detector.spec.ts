import {
  ProductCategory,
  ProductModel,
  ProductReference,
  ProductReferenceCandidate,
  ProductSourceType,
  Sentiment,
  UserComment,
} from "@ebike-backend/database";
import { ResolutionQualityDetector } from "./resolution-quality.detector";
import { DetectionContext } from "../../../interfaces/issue-detector.interface";

function makeCtx(commentBody: string): DetectionContext {
  const comment = new UserComment();
  comment.body = commentBody;
  return {
    commentBody,
    comment,
    issueLabelsIndex: new Map(),
  };
}

function makeCandidate(
  options: {
    model?: Partial<ProductModel>;
    isPrimary?: boolean;
    confidence?: number;
  } = {},
): ProductReferenceCandidate {
  const candidate = new ProductReferenceCandidate();
  candidate.model = (options.model ?? { id: "cand-1" }) as ProductModel;
  candidate.isPrimary = options.isPrimary ?? true;
  candidate.confidence = options.confidence ?? 80;
  candidate.weight = 1;
  return candidate;
}

function makeRef(options: {
  model?: string;
  candidates?: ProductReferenceCandidate[];
  productCategory?: Partial<ProductCategory> | null;
  matchAlias?: string;
  bestScore?: number;
  quoteTexts?: string[];
}): ProductReference {
  const ref = new ProductReference();
  ref.context = {
    identification: { model: options.model },
    resolution: {},
  } as ProductReference["context"];
  if (options.candidates !== undefined) {
    ref.candidates = options.candidates;
  }
  if (
    options.productCategory !== null &&
    options.productCategory !== undefined
  ) {
    ref.productCategory = options.productCategory as ProductCategory;
  }
  if (options.matchAlias) {
    ref.searchContext = {
      candidates: [
        {
          productId: "cand-1",
          source: "fuzzy" as const,
          matchScore: options.bestScore ?? 70,
        },
      ],
      scoring: {
        bestCandidate: {
          candidateId: "cand-1",
          alias: options.matchAlias,
          score: options.bestScore ?? 70,
        },
      },
    } as ProductReference["searchContext"];
  }
  if (options.quoteTexts) {
    ref.quotes = options.quoteTexts.map((text, i) => ({
      id: `q${i}`,
      text,
      sentiment: Sentiment.Neutral,
    }));
  }
  return ref;
}

describe("ResolutionQualityDetector", () => {
  const detector = new ResolutionQualityDetector();

  describe("suffix_alpha_mismatch", () => {
    it("fires when input and candidate trailing alphas disagree", () => {
      const ref = makeRef({
        model: "g8sd",
        matchAlias: "samsung odyssey g8 s32dg802su",
      });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "suffix_alpha_mismatch");
      expect(issues).toHaveLength(1);
    });

    it("does NOT fire when trailing alphas agree", () => {
      const ref = makeRef({
        model: "odyssey oled g8 s34dg850su",
        matchAlias: "samsung odyssey oled g8 s34dg850su",
      });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "suffix_alpha_mismatch");
      expect(issues).toHaveLength(0);
    });
  });

  describe("multiple_candidates_resolved", () => {
    it("fires when ref.candidates.length > 1", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: { id: "p1", displayName: "LG 32GS95UE-B" } as ProductModel,
            isPrimary: true,
          }),
          makeCandidate({
            model: { id: "p2", displayName: "LG 32GS95UE-W" } as ProductModel,
            isPrimary: false,
          }),
        ],
      });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "multiple_candidates_resolved");
      expect(issues).toHaveLength(1);
      expect(issues[0].reasoning).toContain("2 candidates");
      expect(issues[0].reasoning).toContain("LG 32GS95UE-B");
      expect(issues[0].reasoning).toContain("LG 32GS95UE-W");
    });

    it("does NOT fire when ref.candidates has exactly one entry", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: { id: "p1", displayName: "Single" } as ProductModel,
            isPrimary: true,
          }),
        ],
      });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "multiple_candidates_resolved");
      expect(issues).toHaveLength(0);
    });

    it("does NOT fire when ref.candidates is empty", () => {
      const ref = makeRef({ candidates: [] });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "multiple_candidates_resolved");
      expect(issues).toHaveLength(0);
    });
  });

  describe("low_recency_evidence", () => {
    it("fires when ref's quotes carry a recency cue and resolved primary candidate has no releaseYear", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: {
              id: "p1",
              sources: [{ type: ProductSourceType.arukereso }],
            } as Partial<ProductModel> as ProductModel,
            isPrimary: true,
          }),
        ],
        quoteTexts: ["There's a newer version of this model"],
      });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "low_recency_evidence");
      expect(issues).toHaveLength(1);
    });

    it("does NOT fire when no recency cue in the ref's quotes", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: {
              id: "p1",
              sources: [{ type: ProductSourceType.arukereso }],
            } as Partial<ProductModel> as ProductModel,
            isPrimary: true,
          }),
        ],
        quoteTexts: ["I love this monitor."],
      });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "low_recency_evidence");
      expect(issues).toHaveLength(0);
    });

    it("does NOT fire when releaseYear is set", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: {
              id: "p1",
              releaseYear: 2024,
              sources: [{ type: ProductSourceType.arukereso }],
            } as Partial<ProductModel> as ProductModel,
            isPrimary: true,
          }),
        ],
        quoteTexts: ["There's a newer version"],
      });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "low_recency_evidence");
      expect(issues).toHaveLength(0);
    });
  });

  describe("resolved_via_web_search", () => {
    it("fires when web ran and the only accepted candidate appears in searchEvidence.resolvedProducts", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: { id: "p1" } as Partial<ProductModel> as ProductModel,
            isPrimary: true,
          }),
        ],
      });
      ref.searchContext = {
        strategiesRun: ["fuzzy", "web"],
        searchEvidence: [{ resolvedProducts: [{ productId: "p1" }] }],
      } as unknown as ProductReference["searchContext"];
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "resolved_via_web_search");
      expect(issues).toHaveLength(1);
    });

    it("fires when any accepted candidate (not just the primary) was web-surfaced", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: { id: "p1" } as Partial<ProductModel> as ProductModel,
            isPrimary: true,
          }),
          makeCandidate({
            model: { id: "p2" } as Partial<ProductModel> as ProductModel,
            isPrimary: false,
          }),
        ],
      });
      ref.searchContext = {
        strategiesRun: ["fuzzy", "web"],
        searchEvidence: [{ resolvedProducts: [{ productId: "p2" }] }],
      } as unknown as ProductReference["searchContext"];
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "resolved_via_web_search");
      expect(issues).toHaveLength(1);
    });

    it("does NOT fire when web did not run, even if matching evidence exists", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: { id: "p1" } as Partial<ProductModel> as ProductModel,
            isPrimary: true,
          }),
        ],
      });
      ref.searchContext = {
        strategiesRun: ["fuzzy"],
        searchEvidence: [{ resolvedProducts: [{ productId: "p1" }] }],
      } as unknown as ProductReference["searchContext"];
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "resolved_via_web_search");
      expect(issues).toHaveLength(0);
    });

    it("does NOT fire when web ran but no accepted candidate was surfaced by SERP", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: { id: "p1" } as Partial<ProductModel> as ProductModel,
            isPrimary: true,
          }),
        ],
      });
      ref.searchContext = {
        strategiesRun: ["fuzzy", "web"],
        searchEvidence: [{ resolvedProducts: [{ productId: "p2" }] }],
      } as unknown as ProductReference["searchContext"];
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "resolved_via_web_search");
      expect(issues).toHaveLength(0);
    });

    it("does NOT fire when searchEvidence is empty (registry_hit short-circuit)", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: { id: "p1" } as Partial<ProductModel> as ProductModel,
            isPrimary: true,
          }),
        ],
      });
      ref.searchContext = {
        strategiesRun: [],
        searchEvidence: [],
      } as unknown as ProductReference["searchContext"];
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "resolved_via_web_search");
      expect(issues).toHaveLength(0);
    });
  });

  describe("unresolved_after_search", () => {
    it("fires when no primary candidate and category has searchEnabled=true", () => {
      const ref = makeRef({
        candidates: [],
        productCategory: { searchEnabled: true },
      });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "unresolved_after_search");
      expect(issues).toHaveLength(1);
    });

    it("does NOT fire when category has searchEnabled=false", () => {
      const ref = makeRef({
        candidates: [],
        productCategory: { searchEnabled: false },
      });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "unresolved_after_search");
      expect(issues).toHaveLength(0);
    });

    it("does NOT fire when ref has a primary candidate", () => {
      const ref = makeRef({
        candidates: [
          makeCandidate({
            model: {
              id: "p1",
              sources: [{ type: ProductSourceType.arukereso }],
            } as Partial<ProductModel> as ProductModel,
            isPrimary: true,
          }),
        ],
        productCategory: { searchEnabled: true },
      });
      const issues = detector
        .detect(ref, makeCtx(""))
        .filter((i) => i.type === "unresolved_after_search");
      expect(issues).toHaveLength(0);
    });
  });

  it("clean ref with cataloged product, full alias match, and no recency cue produces no issues", () => {
    const ref = makeRef({
      model: "odyssey oled g8 s34dg850su",
      matchAlias: "odyssey oled g8 s34dg850su",
      candidates: [
        makeCandidate({
          model: {
            id: "p1",
            releaseYear: 2024,
            sources: [{ type: ProductSourceType.arukereso }],
          } as Partial<ProductModel> as ProductModel,
          isPrimary: true,
        }),
      ],
      productCategory: { searchEnabled: true },
    });
    expect(detector.detect(ref, makeCtx("I love this monitor."))).toHaveLength(
      0,
    );
  });
});
