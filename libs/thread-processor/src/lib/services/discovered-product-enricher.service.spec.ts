import { Depth, ProductCategory } from "@ebike-backend/database";
import {
  CategoryCacheService,
  CategoryNameMatcherService,
} from "@ebike-backend/product";
import { ThreadContext } from "../models/thread-context";
import { ProductRegistryEntry } from "../models/product-registry.model";
import { DiscoveredProduct } from "../models/discovered-product.model";
import { DiscoveredProductEnricher } from "./discovered-product-enricher.service";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCategory(name: string, enabled: boolean): ProductCategory {
  const category = new ProductCategory();
  category.id = `cat-${name}`;
  category.name = name;
  category.extractionEnabled = enabled;
  return category;
}

function makeDiscovered(
  overrides?: Partial<DiscoveredProduct>,
): DiscoveredProduct {
  return {
    brand: "LG",
    model: "34GS95QE-B",
    categoryHint: "monitor",
    contentQuality: "high",
    linkLabel: "A",
    ...overrides,
  };
}

function makeEnricher(options: {
  enabled: ProductCategory[];
  all: ProductCategory[];
  match: (
    hint: string,
    categories: ProductCategory[],
  ) => ProductCategory | undefined;
}): DiscoveredProductEnricher {
  const cacheStub = {
    getExtractionEnabledCategories: jest.fn(async () => options.enabled),
    getAllCategories: jest.fn(async () => options.all),
  } as unknown as CategoryCacheService;
  const matcherStub = {
    matchByName: jest.fn(options.match),
  } as unknown as CategoryNameMatcherService;
  return new DiscoveredProductEnricher(cacheStub, matcherStub);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DiscoveredProductEnricher", () => {
  describe("category two-pass match", () => {
    it("prefers an enabled category match", async () => {
      const enabled = makeCategory("monitor", true);
      const enricher = makeEnricher({
        enabled: [enabled],
        all: [enabled],
        match: (_hint, categories) => categories[0],
      });
      const context = new ThreadContext();

      const [result] = await enricher.enrich(
        [makeDiscovered()],
        context,
        new Set(),
      );

      expect(result.productCategory).toBe(enabled);
    });

    it("falls back to a disabled (deferred) catalog category when no enabled match", async () => {
      const disabled = makeCategory("keyboard", false);
      const enricher = makeEnricher({
        enabled: [],
        all: [disabled],
        // No enabled categories → first call returns undefined, second returns the disabled one.
        match: (_hint, categories) => categories[0],
      });
      const context = new ThreadContext();

      const [result] = await enricher.enrich(
        [makeDiscovered({ categoryHint: "keyboard" })],
        context,
        new Set(),
      );

      expect(result.productCategory).toBe(disabled);
      expect(result.productCategory?.extractionEnabled).toBe(false);
    });
  });

  describe("spec whitelist", () => {
    it("drops specs whose name is not in the valid set", async () => {
      const enricher = makeEnricher({
        enabled: [],
        all: [],
        match: () => undefined,
      });
      const context = new ThreadContext();

      const [result] = await enricher.enrich(
        [
          makeDiscovered({
            specs: [
              { name: "refreshRate", value: "240Hz" },
              { name: "bogusSpec", value: "nope" },
            ],
          }),
        ],
        context,
        new Set(["refreshRate"]),
      );

      expect(result.filteredSpecs).toEqual([
        { name: "refreshRate", value: "240Hz" },
      ]);
      expect(result.resolutionInput.specs).toEqual([
        { name: "refreshRate", value: "240Hz" },
      ]);
    });
  });

  describe("productLinkId", () => {
    it("mints one UUID per distinct linkLabel and shares it within the batch", async () => {
      const enricher = makeEnricher({
        enabled: [],
        all: [],
        match: () => undefined,
      });
      const context = new ThreadContext();

      const enriched = await enricher.enrich(
        [
          makeDiscovered({ linkLabel: "A", model: "X" }),
          makeDiscovered({ linkLabel: "B", model: "Y" }),
        ],
        context,
        new Set(),
      );

      expect(enriched[0].productLinkId).not.toBe(enriched[1].productLinkId);
      expect(enriched[0].productLinkId).toMatch(/[0-9a-f-]{36}/);
    });

    it("inherits the registry group id on a cross-subtree registry hit", async () => {
      const enricher = makeEnricher({
        enabled: [],
        all: [],
        match: () => undefined,
      });
      const context = new ThreadContext();
      // Seed a prior-subtree registry entry for this product with a group id.
      const entry: ProductRegistryEntry = {
        brand: "lg",
        model: "34gs95qe-b",
        extractedName: "LG 34GS95QE-B",
        displayName: "LG 34GS95QE-B",
        inOp: false,
        recency: "recent",
        referenceCount: 1,
        maxDepth: Depth.Superficial,
        productLinkId: "prior-group-id",
      };
      context.productRegistry.set("lg::34gs95qe-b", entry);

      const [result] = await enricher.enrich(
        [makeDiscovered()],
        context,
        new Set(),
      );

      expect(result.productLinkId).toBe("prior-group-id");
    });

    it("does NOT merge two distinct in-batch labels that fuzzy-collide on one registry entry", async () => {
      const enricher = makeEnricher({
        enabled: [],
        all: [],
        match: () => undefined,
      });
      const context = new ThreadContext();
      // One prior-subtree entry. resolveRegistryKey suffix-matches both the
      // exact model and a truncated sibling mention to this single key.
      const entry: ProductRegistryEntry = {
        brand: "lg",
        model: "34gs95qe-b",
        extractedName: "LG 34GS95QE-B",
        displayName: "LG 34GS95QE-B",
        inOp: false,
        recency: "recent",
        referenceCount: 1,
        maxDepth: Depth.Superficial,
        productLinkId: "prior-group-id",
      };
      context.productRegistry.set("lg::34gs95qe-b", entry);

      const enriched = await enricher.enrich(
        [
          // Label A: exact model → inherits the prior group id.
          makeDiscovered({ linkLabel: "A", model: "34GS95QE-B" }),
          // Label B: a genuinely-distinct sibling whose model is a suffix of A's
          // → fuzzy-resolves to the SAME registry key, but the discovery LLM
          //   called it distinct. It must NOT inherit A's group id.
          makeDiscovered({ linkLabel: "B", model: "95QE-B" }),
        ],
        context,
        new Set(),
      );

      expect(enriched[0].productLinkId).toBe("prior-group-id");
      expect(enriched[1].productLinkId).not.toBe("prior-group-id");
      expect(enriched[1].productLinkId).toMatch(/[0-9a-f-]{36}/);
    });
  });

  describe("OP content-quality override", () => {
    it("is the responsibility of the coordinator (seed time), not the enricher", async () => {
      // The enricher carries the discovered contentQuality through verbatim;
      // the OP `high` override is applied by WideIdentificationPassService when
      // it builds the seed. This documents that boundary.
      const enricher = makeEnricher({
        enabled: [],
        all: [],
        match: () => undefined,
      });
      const context = new ThreadContext();

      const [result] = await enricher.enrich(
        [makeDiscovered({ contentQuality: "low" })],
        context,
        new Set(),
      );

      expect(result.discovered.contentQuality).toBe("low");
      expect(result.resolutionInput.contentQuality).toBe("low");
    });
  });

  describe("resolution input", () => {
    it("carries brand/model/clues and the matched category id", async () => {
      const enabled = makeCategory("monitor", true);
      const enricher = makeEnricher({
        enabled: [enabled],
        all: [enabled],
        match: (_hint, categories) => categories[0],
      });
      const context = new ThreadContext();

      const searchBefore = new Date("2024-03-01T00:00:00Z");
      const [result] = await enricher.enrich(
        [
          makeDiscovered({
            referenceModel: "34GS95QE-B",
            modelClues: ["G8sd"],
            variantClues: ["black remote"],
          }),
        ],
        context,
        new Set(),
        searchBefore,
      );

      const input = result.resolutionInput;
      expect(input.brand).toBe("LG");
      expect(input.referenceModel).toBe("34GS95QE-B");
      expect(input.modelClues).toEqual(["G8sd"]);
      expect(input.variantClues).toEqual(["black remote"]);
      expect(input.category).toEqual({ id: "cat-monitor", name: "monitor" });
      expect(input.contentQuality).toBe("high");
      expect(input.searchBefore).toBe(searchBefore);
    });
  });
});
