import { DecisionService } from "./decision.service";
import { makeTestContext } from "../testing/make-context";
import type { DecisionStrategy } from "../models/strategy-types";
import type { SlimCandidate } from "../models/slim-types";
import type { FinalDecision } from "../models/resolution-context";
import type { MatchResult } from "@ebike-backend/database";
import { EMPTY_MATCH_RESULT_COMPONENTS } from "@ebike-backend/database";
import type { QualityGatesService } from "../matching/quality-gates.service";

function slim(id: string, score?: number): SlimCandidate {
  return {
    productId: id,
    source: "fuzzy",
    matchScore: score,
  };
}

function match(id: string, score: number, alias?: string): MatchResult {
  return {
    candidateId: id,
    alias: alias ?? id,
    score,
    components: { ...EMPTY_MATCH_RESULT_COMPONENTS },
  };
}

function makeStrategy(
  decision: FinalDecision,
  throws = false,
): DecisionStrategy {
  return {
    decide: jest.fn().mockImplementation(async () => {
      if (throws) throw new Error("strategy boom");
      return decision;
    }),
  };
}

/** Build a fake QualityGatesService whose `filterAcceptable` returns a
 *  predetermined list. The decision service does no other interaction. */
function makeGates(filtered: MatchResult[]): QualityGatesService {
  return {
    filterAcceptable: jest.fn().mockReturnValue(filtered),
  } as unknown as QualityGatesService;
}

describe("DecisionService", () => {
  it("synthesizes matcher_reject/no_qualifying_candidates without calling the strategy when candidates is empty", async () => {
    const strategy = makeStrategy({
      kind: "llm_resolved",
      confidence: 99,
      reason: "never_called",
      selectedCandidates: [],
    });
    const service = new DecisionService(strategy, makeGates([]));

    const context = makeTestContext();
    await service.decide(context);

    expect(strategy.decide).not.toHaveBeenCalled();
    expect(context.decision?.kind).toBe("matcher_reject");
    expect(context.decision?.reason).toBe("no_qualifying_candidates");
    expect(context.decision?.selectedCandidates).toEqual([]);
  });

  it("short-circuits with matcher_accept emitting a single pick when filterAcceptable returns one match", async () => {
    const strategy = makeStrategy({
      kind: "llm_resolved",
      confidence: 99,
      reason: "never_called",
      selectedCandidates: [],
    });
    const gates = makeGates([match("p1", 92, "g85sd")]);
    const service = new DecisionService(strategy, gates);

    const context = makeTestContext({
      candidates: [slim("p1", 92)],
      scoringMatches: [match("p1", 92, "g85sd")],
      scoringInputParsed: {},
      scoringMatchConfig: {},
    });
    await service.decide(context);

    expect(strategy.decide).not.toHaveBeenCalled();
    expect(context.decision?.kind).toBe("matcher_accept");
    expect(context.decision?.confidence).toBe(92);
    expect(context.decision?.selectedCandidates).toEqual([
      { candidateId: "p1", confidence: 92, reason: "matcher_accept_best" },
    ]);
  });

  it("emits multiple candidates when filterAcceptable returns more than one", async () => {
    const strategy = makeStrategy({
      kind: "llm_resolved",
      confidence: 0,
      reason: "never_called",
      selectedCandidates: [],
    });
    const gates = makeGates([
      match("p1", 92, "g85sd"),
      match("p2", 89, "g85sb"),
      match("p3", 87, "g85nb"),
    ]);
    const service = new DecisionService(strategy, gates);

    const context = makeTestContext({
      candidates: [slim("p1", 92), slim("p2", 89), slim("p3", 87)],
      scoringMatches: [
        match("p1", 92, "g85sd"),
        match("p2", 89, "g85sb"),
        match("p3", 87, "g85nb"),
      ],
      scoringInputParsed: {},
      scoringMatchConfig: {},
    });
    await service.decide(context);

    expect(strategy.decide).not.toHaveBeenCalled();
    expect(context.decision?.kind).toBe("matcher_accept");
    expect(context.decision?.selectedCandidates).toHaveLength(3);
    expect(context.decision?.selectedCandidates[0]).toEqual({
      candidateId: "p1",
      confidence: 92,
      reason: "matcher_accept_best",
    });
    expect(context.decision?.selectedCandidates[1].reason).toBe(
      "matcher_accept_above_threshold",
    );
  });

  it("matcher_reject/no_candidates_above_threshold when matcher returned nothing and web search did NOT run", async () => {
    const strategy = makeStrategy({
      kind: "llm_resolved",
      confidence: 0,
      reason: "never_called",
      selectedCandidates: [],
    });
    const gates = makeGates([]); // none above floor
    const service = new DecisionService(strategy, gates);

    const context = makeTestContext({
      candidates: [slim("p1", 40)],
      scoringMatches: [match("p1", 40, "g85")],
      scoringInputParsed: {},
      scoringMatchConfig: {},
      // strategiesRun does NOT include 'web'
      strategiesRun: ["fuzzy", "embedding"],
      options: { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
    });
    await service.decide(context);

    expect(strategy.decide).not.toHaveBeenCalled();
    expect(context.decision?.kind).toBe("matcher_reject");
    expect(context.decision?.reason).toBe("no_candidates_above_threshold");
    expect(context.decision?.selectedCandidates).toEqual([]);
  });

  it("delegates to the strategy when matcher returned nothing AND web search ran", async () => {
    const strategy = makeStrategy({
      kind: "llm_resolved",
      confidence: 75,
      reason: "llm_resolved",
      selectedCandidates: [
        { candidateId: "p1", confidence: 75, reason: "llm picked p1" },
      ],
    });
    const gates = makeGates([]);
    const service = new DecisionService(strategy, gates);

    const context = makeTestContext({
      candidates: [slim("p1", 60), slim("p2", 58)],
      scoringMatches: [match("p1", 60), match("p2", 58)],
      scoringInputParsed: {},
      scoringMatchConfig: {},
      strategiesRun: ["fuzzy", "embedding", "web"],
      options: { useEmbedding: true, webSearchEnabled: true, mode: "loose" },
    });
    await service.decide(context);

    expect(strategy.decide).toHaveBeenCalled();
    expect(context.decision?.kind).toBe("llm_resolved");
    expect(context.decision?.selectedCandidates).toEqual([
      { candidateId: "p1", confidence: 75, reason: "llm picked p1" },
    ]);
  });

  it("records a phase error and falls back to llm_unresolved when the strategy throws", async () => {
    const strategy = makeStrategy(
      {
        kind: "llm_resolved",
        confidence: 80,
        reason: "never_reached",
        selectedCandidates: [],
      },
      true,
    );
    const gates = makeGates([]);
    const service = new DecisionService(strategy, gates);

    const context = makeTestContext({
      candidates: [slim("p1")],
      scoringMatches: [match("p1", 40)],
      scoringInputParsed: {},
      scoringMatchConfig: {},
      strategiesRun: ["fuzzy", "web"],
      options: { useEmbedding: true, webSearchEnabled: true, mode: "loose" },
    });
    await service.decide(context);

    expect(context.errors[0].phase).toBe("decision");
    expect(context.decision?.kind).toBe("llm_unresolved");
    expect(context.decision?.reason).toBe("decision_strategy_error");
  });
});
