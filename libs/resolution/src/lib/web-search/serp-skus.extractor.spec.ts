import type { AiChatService } from "@ebike-backend/ai";
import type { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { SerpSkusExtractor } from "./serp-skus.extractor";
import { makeTestContext } from "../testing/make-context";
import type { SearchEvidence } from "../models/search-evidence";

function makeAiChat(
  content: string,
  options?: { throws?: boolean },
): AiChatService {
  return {
    createChat: jest.fn().mockImplementation(async () => {
      if (options?.throws) throw new Error("LLM down");
      return {
        choices: [{ message: { role: "assistant", content } }],
      };
    }),
  } as unknown as AiChatService;
}

function makeDynamicConfig(): DynamicConfigService {
  return {
    search: { webSearch: { extractionModel: "test-model" } },
  } as unknown as DynamicConfigService;
}

function makeRecord(
  index: number,
  queryIntent: SearchEvidence["queryIntent"] = "model_with_specs",
): SearchEvidence {
  return {
    title: `Title ${index}`,
    description: `Desc ${index}`,
    url: `https://example.com/${index}`,
    provider: "dataforseo",
    queryIntent,
    modelNumbers: [],
    resolvedProducts: [],
  };
}

describe("SerpSkusExtractor", () => {
  it("no-ops on empty record list", async () => {
    const aiChat = makeAiChat('{"records":[]}');
    const extractor = new SerpSkusExtractor(aiChat, makeDynamicConfig());
    await extractor.extract(makeTestContext(), []);
    expect(aiChat.createChat).not.toHaveBeenCalled();
  });

  it("maps response model numbers back onto records by index", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({
        records: [
          { index: 0, modelNumbers: ["G85SD"] },
          { index: 1, modelNumbers: ["MPG341CQPX", "mpg341cqpx"] },
        ],
      }),
    );
    const extractor = new SerpSkusExtractor(aiChat, makeDynamicConfig());

    const records = [makeRecord(0), makeRecord(1)];
    await extractor.extract(makeTestContext(), records);

    expect(records[0].modelNumbers).toEqual(["G85SD"]);
    // dedupe preserves first occurrence
    expect(records[1].modelNumbers).toEqual(["MPG341CQPX", "mpg341cqpx"]);
  });

  it("defaults missing-index records to empty array", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({ records: [{ index: 0, modelNumbers: ["G85SD"] }] }),
    );
    const extractor = new SerpSkusExtractor(aiChat, makeDynamicConfig());

    const records = [makeRecord(0), makeRecord(1)];
    await extractor.extract(makeTestContext(), records);

    expect(records[0].modelNumbers).toEqual(["G85SD"]);
    expect(records[1].modelNumbers).toEqual([]);
  });

  it("on LLM failure sets every record's modelNumbers to []", async () => {
    const aiChat = makeAiChat("", { throws: true });
    const extractor = new SerpSkusExtractor(aiChat, makeDynamicConfig());

    const records = [
      { ...makeRecord(0), modelNumbers: ["previous"] },
      makeRecord(1),
    ];
    await extractor.extract(makeTestContext(), records);

    expect(records[0].modelNumbers).toEqual([]);
    expect(records[1].modelNumbers).toEqual([]);
  });

  it("surfaces queryIntent in the user message", async () => {
    const aiChat = makeAiChat('{"records":[]}');
    const extractor = new SerpSkusExtractor(aiChat, makeDynamicConfig());

    const records = [
      makeRecord(0, "cross_market"),
      makeRecord(1, "reference_sibling_sku"),
    ];
    await extractor.extract(
      makeTestContext({ input: { brand: "Samsung", model: "G85SD" } }),
      records,
    );

    const callArgs = (aiChat.createChat as jest.Mock).mock.calls[0][0];
    const userMessage = callArgs.messages[1].content as string;
    expect(userMessage).toContain("(cross_market)");
    expect(userMessage).toContain("(reference_sibling_sku)");
    expect(userMessage).toContain("Samsung");
    expect(userMessage).toContain("G85SD");
  });
});
