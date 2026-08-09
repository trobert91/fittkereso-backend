import type { CategoryConfigService } from "@ebike-backend/config";
import { SpecComparisonService } from "@ebike-backend/product";
import { FilterService } from "./filter.service";
import { InputNormalizationService } from "../matching/input-normalization.service";
import {
  MatchingConfig,
  MatchingConfigService,
} from "../matching/matching-config.service";
import { makeTestContext } from "../testing/make-context";
import type { SlimCandidate } from "../models/slim-types";
import type { ProductSpecs } from "@ebike-backend/database";

const MATCHING_CONFIG: MatchingConfig = {
  acceptThreshold: 55,
  acceptThresholdStrict: 70,
  ambiguityGap: 5,
  defaultStrictness: "moderate",
  defaultNumericTokenWeight: 2.5,
  ambiguityGapAnchored: 10,
};

const MONITORS_CONFIG = {
  matchingConfig: { strictness: "moderate" as const },
  primarySpecs: ["screenSize", "panelType", "resolution"],
  matcherSpecHierarchies: { panelType: { OLED: ["QD-OLED"] } },
};

class StubCategoryConfigService {
  getConfig(slug: string): unknown {
    if (slug === "monitors") return MONITORS_CONFIG;
    return undefined;
  }
}

function makeCandidate(overrides: {
  id: string;
  specs?: ProductSpecs;
  categoryName?: string;
  categorySlug?: string;
  brand?: string;
  brandId?: string;
  model?: string;
  displayName?: string;
}): SlimCandidate {
  return {
    productId: overrides.id,
    source: "fuzzy",
    specs: overrides.specs,
    brand: overrides.brand,
    brandId: overrides.brandId,
    model: overrides.model,
    displayName: overrides.displayName,
    productCategory: {
      id: overrides.categorySlug === "tvs" ? "cat-tvs" : "cat-monitors",
      name: overrides.categoryName ?? "Monitor",
      slug: overrides.categorySlug ?? "monitors",
    },
  };
}

describe("FilterService", () => {
  let service: FilterService;

  beforeEach(() => {
    const specComparison = new SpecComparisonService();
    const matchingConfigService = {
      config: MATCHING_CONFIG,
    } as unknown as MatchingConfigService;
    const inputNormalization = new InputNormalizationService(
      matchingConfigService,
      new StubCategoryConfigService() as unknown as CategoryConfigService,
    );
    service = new FilterService(specComparison, inputNormalization);
  });

  it("keeps candidates whose primary specs satisfy effectiveMatchSpecs", () => {
    const candidate = makeCandidate({
      id: "a",
      specs: { screenSize: '34"', panelType: "OLED" },
    });
    const context = makeTestContext({
      candidates: [candidate],
      effectiveMatchSpecs: { screenSize: '34"' },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(1);
    expect(result.outcome.filteredCandidates).toHaveLength(0);
  });

  it("drops candidates that violate a primary-spec constraint with reason match_specs", () => {
    const candidate = makeCandidate({
      id: "S32DG800SU",
      brand: "Samsung",
      model: "S32DG800SU",
      specs: { screenSize: '32"', panelType: "OLED" },
    });
    const context = makeTestContext({
      candidates: [candidate],
      effectiveMatchSpecs: { screenSize: '34"' },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(0);
    const [rejection] = result.outcome.filteredCandidates;
    expect(rejection.reason).toBe("match_specs");
    expect(rejection.detail).toContain("screenSize");
    expect(rejection.candidateName).toBe("Samsung S32DG800SU");
  });

  it("keeps QD-OLED candidate when reference asks for OLED via matcherSpecHierarchies", () => {
    const candidate = makeCandidate({
      id: "qd",
      specs: { panelType: "QD-OLED" },
    });
    const context = makeTestContext({
      candidates: [candidate],
      effectiveMatchSpecs: { panelType: "OLED" },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(1);
  });

  it("drops candidates with no specs when effectiveMatchSpecs is set", () => {
    const candidate = makeCandidate({ id: "none", specs: undefined });
    const context = makeTestContext({
      candidates: [candidate],
      effectiveMatchSpecs: { screenSize: '34"' },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(0);
    const [rejection] = result.outcome.filteredCandidates;
    expect(rejection.reason).toBe("match_specs");
    expect(rejection.detail).toContain("screenSize");
  });

  it("keeps candidates with no specs when effectiveMatchSpecs is also empty", () => {
    const candidate = makeCandidate({ id: "none", specs: undefined });
    const context = makeTestContext({ candidates: [candidate] });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(1);
  });

  it("falls back to inputSpecs ∩ primarySpecs when effectiveMatchSpecs is empty", () => {
    const candidate = makeCandidate({
      id: "small",
      specs: { screenSize: '27"' },
    });
    const context = makeTestContext({
      candidates: [candidate],
      input: { specs: [{ name: "screenSize", value: '39"' }] },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(0);
    expect(result.outcome.filteredCandidates[0].reason).toBe("match_specs");
  });

  it("drops candidates whose category id differs from ctx.category.id", () => {
    const tv = makeCandidate({
      id: "tv-1",
      brand: "Samsung",
      displayName: 'Samsung Frame 55"',
      specs: { screenSize: '55"' },
      categoryName: "TV",
      categorySlug: "tvs",
    });
    const context = makeTestContext({
      candidates: [tv],
      category: { id: "cat-monitors", name: "Monitor", similarity: 1.0 },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(0);
    const [rejection] = result.outcome.filteredCandidates;
    expect(rejection.reason).toBe("category");
    expect(rejection.candidateName).toBe('Samsung Frame 55"');
  });

  it("keeps candidates whose category id matches even when names differ (Monitors vs monitor)", () => {
    // Regression: the LLM emits a singular categoryHint ("monitor") while
    // catalog rows are stored plural ("Monitors"). The id-equality path keeps
    // the candidate; the name-fallback would have rejected it.
    const candidate = makeCandidate({
      id: "a",
      specs: { screenSize: '34"' },
      categoryName: "Monitors",
    });
    const context = makeTestContext({
      candidates: [candidate],
      category: { id: "cat-monitors", name: "monitor", similarity: 1.0 },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(1);
  });

  it("falls back to case-insensitive name comparison when ctx.category.id is unset", () => {
    const candidate = makeCandidate({ id: "a", specs: { screenSize: '34"' } });
    const context = makeTestContext({
      candidates: [candidate],
      // No id on ctx.category — forces the name-fallback branch.
      category: { id: "", name: "monitor", similarity: 1.0 },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(1);
  });

  it("skips category gate when ctx.category is unset", () => {
    const candidate = makeCandidate({ id: "a", specs: { screenSize: '34"' } });
    const context = makeTestContext({ candidates: [candidate] });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(1);
  });

  it("prefers category rejection over spec rejection when both fail", () => {
    const tv = makeCandidate({
      id: "tv-32",
      specs: { screenSize: '32"' },
      categoryName: "TV",
      categorySlug: "tvs",
    });
    const context = makeTestContext({
      candidates: [tv],
      effectiveMatchSpecs: { screenSize: '34"' },
      category: { id: "cat-monitors", name: "Monitor", similarity: 1.0 },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(0);
    expect(result.outcome.filteredCandidates[0].reason).toBe("category");
  });

  it("keeps candidates whose brand id matches ctx.brand.id", () => {
    const candidate = makeCandidate({
      id: "a",
      brand: "Samsung",
      brandId: "brand-samsung",
      specs: { screenSize: '34"' },
    });
    const context = makeTestContext({
      candidates: [candidate],
      brand: { id: "brand-samsung", name: "Samsung", similarity: 1.0 },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(1);
    expect(result.outcome.filteredCandidates).toHaveLength(0);
  });

  it("drops candidates whose brand id differs from ctx.brand.id with reason brand", () => {
    const lg = makeCandidate({
      id: "lg-1",
      brand: "LG",
      brandId: "brand-lg",
      model: "34GX900A-B",
      specs: { screenSize: '34"' },
    });
    const context = makeTestContext({
      candidates: [lg],
      brand: { id: "brand-samsung", name: "Samsung", similarity: 1.0 },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(0);
    const [rejection] = result.outcome.filteredCandidates;
    expect(rejection.reason).toBe("brand");
    expect(rejection.detail).toContain("Samsung");
    expect(rejection.detail).toContain("LG");
    expect(rejection.candidateName).toBe("LG 34GX900A-B");
  });

  it("prefers brand rejection over category rejection when both fail", () => {
    const lgTv = makeCandidate({
      id: "lg-tv",
      brand: "LG",
      brandId: "brand-lg",
      specs: { screenSize: '55"' },
      categoryName: "TV",
      categorySlug: "tvs",
    });
    const context = makeTestContext({
      candidates: [lgTv],
      brand: { id: "brand-samsung", name: "Samsung", similarity: 1.0 },
      category: { id: "cat-monitors", name: "Monitor", similarity: 1.0 },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(0);
    expect(result.outcome.filteredCandidates[0].reason).toBe("brand");
  });

  it("skips brand gate when ctx.brand is unset", () => {
    const candidate = makeCandidate({
      id: "a",
      brand: "LG",
      brandId: "brand-lg",
      specs: { screenSize: '34"' },
    });
    const context = makeTestContext({ candidates: [candidate] });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(1);
  });

  it("falls back to case-insensitive brand name comparison when candidate lacks brand id", () => {
    const candidate = makeCandidate({
      id: "a",
      brand: "samsung",
      specs: { screenSize: '34"' },
    });
    const context = makeTestContext({
      candidates: [candidate],
      brand: { id: "brand-samsung", name: "Samsung", similarity: 1.0 },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(1);
  });

  it("rejects candidate with no brand at all when ctx.brand is set", () => {
    const candidate = makeCandidate({
      id: "no-brand",
      specs: { screenSize: '34"' },
    });
    const context = makeTestContext({
      candidates: [candidate],
      brand: { id: "brand-samsung", name: "Samsung", similarity: 1.0 },
    });
    const result = service.filter(context);
    expect(result.qualifyingCandidates).toHaveLength(0);
    expect(result.outcome.filteredCandidates[0].reason).toBe("brand");
  });
});
