import type { ProductWebSearchService } from "@ebike-backend/product";
import { WebResearchRecallStrategy } from "./web-research.recall";
import type { WebSearchKeywordBuilder } from "../../web-search/web-search-keyword.builder";
import type { SerpSkusExtractor } from "../../web-search/serp-skus.extractor";
import type { CatalogResolver } from "../../web-search/catalog-resolver";
import { makeTestContext } from "../../testing/make-context";
import type {
  SearchEvidence,
  WebQueryIntent,
} from "../../models/search-evidence";
import type { SlimCandidate } from "../../models/slim-types";

function makeWebSearch(
  byKeyword: Record<
    string,
    {
      results: Array<{ title: string; url: string; description?: string }>;
      provider?: "dataforseo" | "exa";
      cacheHit?: boolean;
    }
  > = {},
): ProductWebSearchService {
  return {
    search: jest
      .fn()
      .mockImplementation(async ({ keyword }: { keyword: string }) => {
        const entry = byKeyword[keyword];
        if (!entry)
          return {
            results: [],
            provider: "dataforseo",
            cacheHit: false,
            source: "api",
            providerSelectionReason: "default_provider_dataforseo",
          };
        return {
          results: entry.results,
          provider: entry.provider ?? "dataforseo",
          cacheHit: entry.cacheHit ?? false,
          source: "api",
          providerSelectionReason: "default_provider_dataforseo",
        };
      }),
  } as unknown as ProductWebSearchService;
}

function makeKeywordBuilder(
  byIntent: Partial<Record<WebQueryIntent, string | undefined>>,
): WebSearchKeywordBuilder {
  return {
    build: jest.fn((intent: WebQueryIntent) => byIntent[intent]),
  } as unknown as WebSearchKeywordBuilder;
}

function makeExtractor(): SerpSkusExtractor {
  return {
    extract: jest.fn().mockResolvedValue(undefined),
  } as unknown as SerpSkusExtractor;
}

function makeCatalogResolver(
  addedCandidates: SlimCandidate[] = [],
  webOnlyModels: string[] = [],
): CatalogResolver {
  return {
    resolve: jest.fn().mockResolvedValue({ addedCandidates, webOnlyModels }),
  } as unknown as CatalogResolver;
}

describe("WebResearchRecallStrategy", () => {
  describe("shouldRun", () => {
    it("false when options.webSearchEnabled is false", () => {
      const strategy = new WebResearchRecallStrategy(
        makeWebSearch(),
        makeKeywordBuilder({}),
        makeExtractor(),
        makeCatalogResolver(),
      );
      const context = makeTestContext({
        options: { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
      });
      expect(strategy.shouldRun(context)).toBe(false);
    });

    it("true when reference product is set (always run for variant search)", () => {
      const strategy = new WebResearchRecallStrategy(
        makeWebSearch(),
        makeKeywordBuilder({}),
        makeExtractor(),
        makeCatalogResolver(),
      );
      const context = makeTestContext({
        options: { useEmbedding: true, webSearchEnabled: true, mode: "loose" },
        referenceProduct: { productId: "r1", specs: {} },
        candidates: [{ productId: "a", source: "fuzzy" }],
      });
      expect(strategy.shouldRun(context)).toBe(true);
    });

    it("false when no reference and fuzzy/embedding already returned candidates", () => {
      const strategy = new WebResearchRecallStrategy(
        makeWebSearch(),
        makeKeywordBuilder({}),
        makeExtractor(),
        makeCatalogResolver(),
      );
      const context = makeTestContext({
        options: { useEmbedding: true, webSearchEnabled: true, mode: "loose" },
        candidates: [{ productId: "a", source: "fuzzy" }],
      });
      expect(strategy.shouldRun(context)).toBe(false);
    });

    it("true when web is enabled and no candidates yet (fallback path)", () => {
      const strategy = new WebResearchRecallStrategy(
        makeWebSearch(),
        makeKeywordBuilder({}),
        makeExtractor(),
        makeCatalogResolver(),
      );
      const context = makeTestContext({
        options: { useEmbedding: true, webSearchEnabled: true, mode: "loose" },
      });
      expect(strategy.shouldRun(context)).toBe(true);
    });

    it("false when web is already in strategiesRun even if referenceProduct is set", () => {
      const strategy = new WebResearchRecallStrategy(
        makeWebSearch(),
        makeKeywordBuilder({}),
        makeExtractor(),
        makeCatalogResolver(),
      );
      const context = makeTestContext({
        options: { useEmbedding: true, webSearchEnabled: true, mode: "loose" },
        referenceProduct: { productId: "r1", specs: {} },
        strategiesRun: ["web"],
      });
      expect(strategy.shouldRun(context)).toBe(false);
    });
  });

  describe("pickIntents (via recall)", () => {
    it("picks reference_sibling_sku only when referenceProduct is set", async () => {
      const keywordBuilder = makeKeywordBuilder({
        reference_sibling_sku: '"Samsung S95D" G85SD',
      });
      const strategy = new WebResearchRecallStrategy(
        makeWebSearch(),
        keywordBuilder,
        makeExtractor(),
        makeCatalogResolver(),
      );

      const context = makeTestContext({
        referenceProduct: {
          productId: "r1",
          specs: {},
          brand: "Samsung",
          model: "S95D",
        },
      });
      await strategy.recall(context);

      const builderCalls = (keywordBuilder.build as jest.Mock).mock.calls.map(
        (args) => args[0],
      );
      expect(builderCalls).toEqual(["reference_sibling_sku"]);
    });

    it("picks model_with_specs + cross_market for unanchored when brand+model present", async () => {
      const keywordBuilder = makeKeywordBuilder({
        model_with_specs: '"Samsung G85SD" 34"',
        cross_market: '"Samsung G85SD" equivalent model name US EU UK',
      });
      const strategy = new WebResearchRecallStrategy(
        makeWebSearch(),
        keywordBuilder,
        makeExtractor(),
        makeCatalogResolver(),
      );

      const context = makeTestContext({
        input: { brand: "Samsung", model: "G85SD" },
      });
      await strategy.recall(context);

      const builderCalls = (keywordBuilder.build as jest.Mock).mock.calls.map(
        (args) => args[0],
      );
      expect(builderCalls).toEqual(["model_with_specs", "cross_market"]);
    });

    it("drops cross_market when brand or model is missing", async () => {
      const keywordBuilder = makeKeywordBuilder({
        model_with_specs: '"G85SD"',
      });
      const strategy = new WebResearchRecallStrategy(
        makeWebSearch(),
        keywordBuilder,
        makeExtractor(),
        makeCatalogResolver(),
      );

      const context = makeTestContext({ input: { model: "G85SD" } });
      await strategy.recall(context);

      const builderCalls = (keywordBuilder.build as jest.Mock).mock.calls.map(
        (args) => args[0],
      );
      expect(builderCalls).toEqual(["model_with_specs"]);
    });
  });

  describe("keyword dedupe", () => {
    it("skips queries whose normalized keyword is already in searchedKeywords", async () => {
      const webSearch = makeWebSearch({
        '"Samsung G85SD" 34"': { results: [] },
      });
      const keywordBuilder = makeKeywordBuilder({
        model_with_specs: '"Samsung G85SD" 34"',
      });
      const strategy = new WebResearchRecallStrategy(
        webSearch,
        keywordBuilder,
        makeExtractor(),
        makeCatalogResolver(),
      );

      const context = makeTestContext({
        input: { model: "G85SD" },
        searchedKeywords: ['"samsung g85sd" 34"'],
      });
      await strategy.recall(context);

      expect(webSearch.search).not.toHaveBeenCalled();
    });
  });

  describe("SERP union → one LLM call → catalog resolve", () => {
    it("dedupes evidence by URL across queries before SKU extraction", async () => {
      const webSearch = makeWebSearch({
        '"Samsung G85SD" 34"': {
          results: [
            { title: "t1", url: "https://x/A" },
            { title: "t2", url: "https://x/B" },
          ],
        },
        '"Samsung G85SD" equivalent model name US EU UK': {
          results: [
            { title: "cm1", url: "https://x/B" },
            { title: "cm2", url: "https://x/C" },
          ],
        },
      });
      const keywordBuilder = makeKeywordBuilder({
        model_with_specs: '"Samsung G85SD" 34"',
        cross_market: '"Samsung G85SD" equivalent model name US EU UK',
      });
      const extractor = makeExtractor();
      const strategy = new WebResearchRecallStrategy(
        webSearch,
        keywordBuilder,
        extractor,
        makeCatalogResolver(),
      );

      const context = makeTestContext({
        input: { brand: "Samsung", model: "G85SD" },
      });
      await strategy.recall(context);

      const callArgs = (extractor.extract as jest.Mock).mock.calls[0];
      const records: SearchEvidence[] = callArgs[1];
      // Three distinct URLs after dedupe
      expect(records.map((r) => r.url).sort()).toEqual([
        "https://x/A",
        "https://x/B",
        "https://x/C",
      ]);
      // First-seen queryIntent wins for B
      expect(records.find((r) => r.url === "https://x/B")?.queryIntent).toBe(
        "model_with_specs",
      );
      expect(extractor.extract).toHaveBeenCalledTimes(1);
    });

    it("writes deduped evidence + WebQueryRecord entries onto the context", async () => {
      const webSearch = makeWebSearch({
        '"Samsung G85SD" 34"': {
          results: [{ title: "t", url: "https://x/A" }],
          cacheHit: true,
        },
      });
      const keywordBuilder = makeKeywordBuilder({
        model_with_specs: '"Samsung G85SD" 34"',
      });
      const strategy = new WebResearchRecallStrategy(
        webSearch,
        keywordBuilder,
        makeExtractor(),
        makeCatalogResolver(),
      );

      const context = makeTestContext({
        input: { brand: "Samsung", model: "G85SD" },
      });
      await strategy.recall(context);

      expect(context.webResearch?.queries).toEqual([
        {
          intent: "model_with_specs",
          keyword: '"Samsung G85SD" 34"',
          provider: "dataforseo",
          cacheHit: true,
          serpResultCount: 1,
        },
      ]);
      expect(context.searchEvidence).toHaveLength(1);
    });

    it("returns the catalog resolver's addedCandidates with source=web", async () => {
      const webSearch = makeWebSearch({
        '"Samsung G85SD" 34"': {
          results: [{ title: "t", url: "https://x/A" }],
        },
      });
      const keywordBuilder = makeKeywordBuilder({
        model_with_specs: '"Samsung G85SD" 34"',
      });
      const added: SlimCandidate[] = [
        { productId: "p1", source: "web" },
        { productId: "p2", source: "web" },
      ];
      const strategy = new WebResearchRecallStrategy(
        webSearch,
        keywordBuilder,
        makeExtractor(),
        makeCatalogResolver(added, ["NOMATCH"]),
      );

      const context = makeTestContext({
        input: { brand: "Samsung", model: "G85SD" },
      });
      const result = await strategy.recall(context);

      expect(result).toEqual(added);
      expect(context.webResearch?.webOnlyModels).toEqual(["NOMATCH"]);
    });

    it("aggregates extracted modelNumbers across records into webResearch.extractedModelNumbers", async () => {
      const webSearch = makeWebSearch({
        '"Samsung G85SD" 34"': {
          results: [
            { title: "t", url: "https://x/A" },
            { title: "t2", url: "https://x/B" },
          ],
        },
      });
      const keywordBuilder = makeKeywordBuilder({
        model_with_specs: '"Samsung G85SD" 34"',
      });
      const extractor = {
        extract: jest
          .fn()
          .mockImplementation(async (_ctx, records: SearchEvidence[]) => {
            records[0].modelNumbers = ["LS32DG802SNXZA", "G85SD"];
            records[1].modelNumbers = ["G85SD"];
          }),
      } as unknown as SerpSkusExtractor;
      const strategy = new WebResearchRecallStrategy(
        webSearch,
        keywordBuilder,
        extractor,
        makeCatalogResolver(),
      );

      const context = makeTestContext({
        input: { brand: "Samsung", model: "G85SD" },
      });
      await strategy.recall(context);

      expect(new Set(context.webResearch?.extractedModelNumbers ?? [])).toEqual(
        new Set(["LS32DG802SNXZA", "G85SD"]),
      );
    });
  });

  describe("error paths", () => {
    it("records a phase error and continues when a SERP fetch rejects", async () => {
      const webSearch = {
        search: jest
          .fn()
          .mockResolvedValueOnce({
            results: [{ title: "t", url: "https://x/A" }],
            provider: "dataforseo",
            cacheHit: false,
            source: "api",
            providerSelectionReason: "default_provider_dataforseo",
          })
          .mockRejectedValueOnce(new Error("serp down")),
      } as unknown as ProductWebSearchService;
      const keywordBuilder = makeKeywordBuilder({
        model_with_specs: '"Samsung G85SD" 34"',
        cross_market: '"Samsung G85SD" equivalent model name US EU UK',
      });
      const strategy = new WebResearchRecallStrategy(
        webSearch,
        keywordBuilder,
        makeExtractor(),
        makeCatalogResolver(),
      );

      const context = makeTestContext({
        input: { brand: "Samsung", model: "G85SD" },
      });
      await strategy.recall(context);

      expect(context.errors).toHaveLength(1);
      expect(context.errors[0].phase).toBe("recall");
      expect(context.errors[0].detail).toBe("web:cross_market");
      // The successful query still produced one evidence record
      expect(context.searchEvidence).toHaveLength(1);
    });
  });
});
