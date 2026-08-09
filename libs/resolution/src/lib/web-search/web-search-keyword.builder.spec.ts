import type { CategoryConfigService } from "@ebike-backend/config";
import { WebSearchKeywordBuilder } from "./web-search-keyword.builder";
import { makeTestContext } from "../testing/make-context";

function makeCategoryConfigStub(
  slugToSuffix: Record<string, string>,
): CategoryConfigService {
  return {
    getConfig(slug: string | null | undefined) {
      if (!slug) return undefined;
      const suffix = slugToSuffix[slug];
      if (!suffix) return undefined;
      return { promptConfig: { searchKeywordSuffix: suffix } };
    },
  } as unknown as CategoryConfigService;
}

describe("WebSearchKeywordBuilder", () => {
  let builder: WebSearchKeywordBuilder;

  beforeEach(() => {
    builder = new WebSearchKeywordBuilder(
      makeCategoryConfigStub({ monitors: "monitor", headphones: "headphones" }),
    );
  });

  describe("exact_model", () => {
    it('builds "<brand> <model>" + suffix when category slug present (via candidate)', () => {
      const context = makeTestContext({
        input: { brand: "LG", model: "34GS95QE" },
        candidates: [
          {
            productId: "p1",
            source: "fuzzy",
            productCategory: { id: "c", name: "Monitor", slug: "monitors" },
          },
        ],
      });
      expect(builder.build("exact_model", context)).toBe(
        '"LG 34GS95QE" monitor',
      );
    });

    it("omits suffix when no candidate carries a slug", () => {
      const context = makeTestContext({
        input: { brand: "LG", model: "34GS95QE" },
      });
      expect(builder.build("exact_model", context)).toBe('"LG 34GS95QE"');
    });

    it("returns undefined when no brand or model is available", () => {
      const context = makeTestContext({ input: {} });
      expect(builder.build("exact_model", context)).toBeUndefined();
    });
  });

  describe("model_with_specs", () => {
    it("appends the first effectiveMatchSpecs values", () => {
      const context = makeTestContext({
        input: { brand: "LG", model: "34GS95QE" },
        effectiveMatchSpecs: { screenSize: '34"', panelType: "OLED" },
      });
      expect(builder.build("model_with_specs", context)).toBe(
        '"LG 34GS95QE" 34" OLED',
      );
    });

    it("falls back to input.specs when effectiveMatchSpecs is empty", () => {
      const context = makeTestContext({
        input: {
          brand: "LG",
          model: "34GS95QE",
          specs: [
            { name: "screenSize", value: '34"' },
            { name: "refreshRate", value: "240Hz" },
          ],
        },
      });
      expect(builder.build("model_with_specs", context)).toBe(
        '"LG 34GS95QE" 34" 240Hz',
      );
    });
  });

  describe("reference_sibling_sku", () => {
    it("uses referenceProduct brand/model + modelClues + variantClues", () => {
      const context = makeTestContext({
        input: { modelClues: ["G85SD"], variantClues: ["full-size ports"] },
        referenceProduct: {
          productId: "ref-1",
          brand: "Samsung",
          model: "S95D",
          productCategory: { id: "c", name: "Monitor", slug: "monitors" },
          specs: {},
        },
      });
      expect(builder.build("reference_sibling_sku", context)).toBe(
        '"Samsung S95D" G85SD full-size ports monitor',
      );
    });

    it("falls back to input.referenceModel when no reference entity", () => {
      const context = makeTestContext({
        input: {
          brand: "Samsung",
          referenceModel: "S95D",
          modelClues: ["G85SD"],
        },
      });
      expect(builder.build("reference_sibling_sku", context)).toBe(
        '"Samsung S95D" G85SD',
      );
    });

    it("returns undefined when no seed is available", () => {
      const context = makeTestContext({ input: {} });
      expect(builder.build("reference_sibling_sku", context)).toBeUndefined();
    });
  });

  describe("cross_market", () => {
    it("builds the cross-market regional rename query", () => {
      const context = makeTestContext({
        input: { brand: "Samsung", model: "G85SD" },
        candidates: [
          {
            productId: "p1",
            source: "fuzzy",
            productCategory: { id: "c", name: "Monitor", slug: "monitors" },
          },
        ],
      });
      expect(builder.build("cross_market", context)).toBe(
        '"Samsung G85SD" equivalent model name US EU UK monitor',
      );
    });

    it("returns undefined when brand or model is missing", () => {
      const context = makeTestContext({ input: { model: "G85SD" } });
      expect(builder.build("cross_market", context)).toBeUndefined();
    });

    it("uses ctx.brand.name when input.brand is unset", () => {
      const context = makeTestContext({
        input: { model: "G85SD" },
        brand: { id: "b1", name: "Samsung", similarity: 1.0 },
      });
      expect(builder.build("cross_market", context)).toBe(
        '"Samsung G85SD" equivalent model name US EU UK',
      );
    });
  });
});
