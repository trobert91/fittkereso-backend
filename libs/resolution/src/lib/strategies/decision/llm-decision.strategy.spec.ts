import type { AiChatService } from "@ebike-backend/ai";
import type { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { LlmDecisionStrategy } from "./llm-decision.strategy";
import { makeTestContext } from "../../testing/make-context";
import type { SlimCandidate } from "../../models/slim-types";
import type { SearchEvidence } from "../../models/search-evidence";
import type { MatchingConfigService } from "../../matching/matching-config.service";

function makeAiChat(
  content: string,
  options?: { throws?: boolean },
): AiChatService {
  return {
    createChat: jest.fn().mockImplementation(async () => {
      if (options?.throws) throw new Error("LLM down");
      return { choices: [{ message: { role: "assistant", content } }] };
    }),
  } as unknown as AiChatService;
}

function makeDynamicConfig(
  overrides: { decisionModel?: string; maxLlmPicks?: number } = {},
): DynamicConfigService {
  return {
    search: {
      decisionModel: overrides.decisionModel ?? "test-model",
    },
    resolution: {
      matching: {
        maxLlmPicks: overrides.maxLlmPicks,
      },
    },
  } as unknown as DynamicConfigService;
}

function makeMatchingConfig(
  overrides: { acceptThreshold?: number; acceptThresholdStrict?: number } = {},
): MatchingConfigService {
  return {
    config: {
      acceptThreshold: overrides.acceptThreshold ?? 70,
      acceptThresholdStrict: overrides.acceptThresholdStrict ?? 80,
      ambiguityGap: 5,
      ambiguityGapAnchored: 10,
      defaultStrictness: "moderate" as const,
      defaultNumericTokenWeight: 2.5,
    },
  } as unknown as MatchingConfigService;
}

function slim(
  id: string,
  overrides: Partial<SlimCandidate> = {},
): SlimCandidate {
  return {
    productId: id,
    source: "fuzzy",
    brand: "Samsung",
    model: id,
    ...overrides,
  };
}

describe("LlmDecisionStrategy", () => {
  it("returns no_qualifying_candidates without calling the LLM when context.candidates is empty", async () => {
    const aiChat = makeAiChat("");
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    const decision = await strategy.decide(makeTestContext());

    expect(aiChat.createChat).not.toHaveBeenCalled();
    expect(decision.kind).toBe("llm_unresolved");
    expect(decision.reason).toBe("no_qualifying_candidates");
    expect(decision.confidence).toBe(0);
    expect(decision.selectedCandidates).toEqual([]);
  });

  it("returns llm_resolved with the picked candidate when LLM returns a single pick above threshold", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({
        picks: [
          { candidateId: "c1", confidence: 85, reason: "exact alias match" },
        ],
        evidenceSummary: "comment + SERP both name p1",
      }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    const context = makeTestContext({ candidates: [slim("p1"), slim("p2")] });
    const decision = await strategy.decide(context);

    expect(decision.kind).toBe("llm_resolved");
    expect(decision.confidence).toBe(85);
    expect(decision.selectedCandidates).toEqual([
      { candidateId: "p1", confidence: 85, reason: "exact alias match" },
    ]);
  });

  it("returns llm_resolved with N picks sorted by confidence desc when LLM returns multiple", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({
        picks: [
          { candidateId: "c2", confidence: 80, reason: "EU variant" },
          {
            candidateId: "c1",
            confidence: 90,
            reason: "NA variant — primary regional match",
          },
        ],
        evidenceSummary: "two regional variants plausible",
      }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    const context = makeTestContext({ candidates: [slim("p1"), slim("p2")] });
    const decision = await strategy.decide(context);

    expect(decision.kind).toBe("llm_resolved");
    expect(decision.confidence).toBe(90);
    expect(decision.selectedCandidates.map((p) => p.candidateId)).toEqual([
      "p1",
      "p2",
    ]);
    expect(decision.selectedCandidates[0].confidence).toBe(90);
    expect(decision.selectedCandidates[1].confidence).toBe(80);
  });

  it("drops hallucinated short ids the LLM returned that are not in the candidate list", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({
        picks: [
          { candidateId: "c1", confidence: 85, reason: "real candidate" },
          { candidateId: "c99", confidence: 80, reason: "hallucinated id" },
        ],
        evidenceSummary: "one valid, one made up",
      }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    const decision = await strategy.decide(
      makeTestContext({ candidates: [slim("p1"), slim("p2")] }),
    );

    expect(decision.kind).toBe("llm_resolved");
    expect(decision.selectedCandidates).toEqual([
      { candidateId: "p1", confidence: 85, reason: "real candidate" },
    ]);
  });

  it("drops picks below acceptThreshold per-candidate; survivors remain", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({
        picks: [
          { candidateId: "c1", confidence: 85, reason: "strong" },
          { candidateId: "c2", confidence: 60, reason: "weak" },
        ],
        evidenceSummary: "mixed",
      }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig({ acceptThreshold: 70 }),
    );

    const decision = await strategy.decide(
      makeTestContext({ candidates: [slim("p1"), slim("p2")] }),
    );

    expect(decision.kind).toBe("llm_resolved");
    expect(decision.selectedCandidates).toEqual([
      { candidateId: "p1", confidence: 85, reason: "strong" },
    ]);
  });

  it("returns below_accept_threshold when all picks fall below the gate", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({
        picks: [
          { candidateId: "c1", confidence: 60, reason: "weak" },
          { candidateId: "c2", confidence: 55, reason: "weaker" },
        ],
        evidenceSummary: "all weak",
      }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig({ acceptThreshold: 70 }),
    );

    const decision = await strategy.decide(
      makeTestContext({ candidates: [slim("p1"), slim("p2")] }),
    );

    expect(decision.kind).toBe("llm_unresolved");
    expect(decision.reason).toBe("below_accept_threshold");
    expect(decision.confidence).toBe(60); // max of the original picks for diagnostics
    expect(decision.selectedCandidates).toEqual([]);
  });

  it('uses acceptThresholdStrict when context.options.mode === "strict"', async () => {
    const aiChat = makeAiChat(
      JSON.stringify({
        picks: [{ candidateId: "c1", confidence: 75, reason: "loose-passing" }],
        evidenceSummary: "strict-mode test",
      }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig({ acceptThreshold: 70, acceptThresholdStrict: 80 }),
    );

    const decision = await strategy.decide(
      makeTestContext({
        candidates: [slim("p1")],
        options: {
          useEmbedding: true,
          webSearchEnabled: false,
          mode: "strict",
        },
      }),
    );

    expect(decision.kind).toBe("llm_unresolved");
    expect(decision.reason).toBe("below_accept_threshold");
  });

  it("classifies as family_only_evidence when LLM returns no picks and no SERP record resolved a product", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({
        picks: [],
        evidenceSummary: "family-only",
      }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    const evidence: SearchEvidence[] = [
      {
        title: "t",
        description: "d",
        url: "https://x/A",
        provider: "dataforseo",
        queryIntent: "model_with_specs",
        modelNumbers: ["G8"],
        resolvedProducts: [], // empty = family-only
      },
    ];
    const context = makeTestContext({
      candidates: [slim("p1")],
      searchEvidence: evidence,
    });
    const decision = await strategy.decide(context);

    expect(decision.kind).toBe("llm_unresolved");
    expect(decision.reason).toBe("family_only_evidence");
  });

  it("classifies as llm_returned_none when LLM unresolved but no evidence", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({ picks: [], evidenceSummary: "unclear" }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    const decision = await strategy.decide(
      makeTestContext({ candidates: [slim("p1")] }),
    );
    expect(decision.kind).toBe("llm_unresolved");
    expect(decision.reason).toBe("llm_returned_none");
  });

  it("returns decision_llm_error on LLM exception", async () => {
    const aiChat = makeAiChat("", { throws: true });
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    const decision = await strategy.decide(
      makeTestContext({ candidates: [slim("p1")] }),
    );

    expect(decision.kind).toBe("llm_unresolved");
    expect(decision.reason).toBe("decision_llm_error");
    expect(decision.confidence).toBe(0);
  });

  it("renders short ids (c1, c2, ...) in the prompt and round-trips them back to productIds", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({
        picks: [
          { candidateId: "c2", confidence: 85, reason: "second candidate" },
        ],
        evidenceSummary: "short-id round trip",
      }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    const decision = await strategy.decide(
      makeTestContext({ candidates: [slim("p1"), slim("p2")] }),
    );

    // Prompt uses short ids.
    const callArgs = (aiChat.createChat as jest.Mock).mock.calls[0][0];
    const user = callArgs.messages[1].content as string;
    expect(user).toContain("id=c1");
    expect(user).toContain("id=c2");

    // Response was reverse-mapped to the real productId.
    expect(decision.selectedCandidates).toEqual([
      { candidateId: "p2", confidence: 85, reason: "second candidate" },
    ]);
  });

  it("surfaces multi-pick guidance in the system prompt", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({ picks: [], evidenceSummary: "" }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    await strategy.decide(makeTestContext({ candidates: [slim("p1")] }));

    const callArgs = (aiChat.createChat as jest.Mock).mock.calls[0][0];
    const system = callArgs.messages[0].content as string;
    expect(system).toContain("0..6 catalog candidates");
    expect(system).toContain("Multi-pick rules");
    expect(system).toContain("Cross-market reasoning");
  });

  it("renders threadContext (subreddit, title, commentBody, parent/grandparent) into the user message", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({ picks: [], evidenceSummary: "" }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    await strategy.decide(makeTestContext({ candidates: [slim("p1")] }), {
      threadTitle: 'Looking for a 34" OLED',
      subreddit: "Monitors",
      commentBody: "I have the LG 34GS95QE-B",
      parentCommentBody: "parent context body",
      grandparentCommentBody: "grandparent context body",
    });

    const callArgs = (aiChat.createChat as jest.Mock).mock.calls[0][0];
    const user = callArgs.messages[1].content as string;
    expect(user).toContain("r/Monitors");
    expect(user).toContain('Looking for a 34" OLED');
    expect(user).toContain("LG 34GS95QE-B");
    expect(user).toContain("## Parent Comment");
    expect(user).toContain("parent context body");
    expect(user).toContain("## Grandparent Comment");
    expect(user).toContain("grandparent context body");
  });

  it("renders the Reference Product section when context.referenceProduct is set", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({ picks: [], evidenceSummary: "" }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    await strategy.decide(
      makeTestContext({
        candidates: [slim("p1")],
        referenceProduct: {
          productId: "ref-1",
          brand: "LG",
          model: "32GS95UE-B",
          productCategory: { id: "cat-1", name: "Monitor" },
          specs: { panelType: "QD-OLED", refreshRate: "240Hz" },
        },
      }),
    );

    const callArgs = (aiChat.createChat as jest.Mock).mock.calls[0][0];
    const user = callArgs.messages[1].content as string;
    expect(user).toContain("## Reference Product");
    expect(user).toContain("Brand: LG");
    expect(user).toContain("Model: 32GS95UE-B");
    expect(user).toContain("Reference specs:");
    expect(user).toContain("panelType=QD-OLED");
  });

  it("renders extracted specs (input.specs) under the Product to Identify block", async () => {
    const aiChat = makeAiChat(
      JSON.stringify({ picks: [], evidenceSummary: "" }),
    );
    const strategy = new LlmDecisionStrategy(
      aiChat,
      makeDynamicConfig(),
      makeMatchingConfig(),
    );

    await strategy.decide(
      makeTestContext({
        candidates: [slim("p1")],
        input: {
          brand: "LG",
          model: "32GS95",
          specs: [
            { name: "panelType", value: "QD-OLED" },
            { name: "displaySize", value: '32"' },
          ],
        },
      }),
    );

    const callArgs = (aiChat.createChat as jest.Mock).mock.calls[0][0];
    const user = callArgs.messages[1].content as string;
    expect(user).toContain(
      'Extracted specs: panelType=QD-OLED, displaySize=32"',
    );
  });
});
