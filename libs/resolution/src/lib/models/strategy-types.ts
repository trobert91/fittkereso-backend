import type { ChatTraceData } from "@ebike-backend/debug";
import type { ResolutionContext } from "./resolution-context";
import type { FinalDecision } from "./resolution-context";
import type { SlimCandidate } from "./slim-types";
import type { ResolutionThreadContext } from "./caller-context";

/**
 * Recall strategies produce candidates from some signal source.
 *
 * Each strategy owns its own gating (`shouldRun`) and its own seed generation
 * (variants, embeddings, query descriptors). `RecallService` iterates the
 * registered strategies once per call; the orchestrator
 * (`ResolutionService`) calls `RecallService.recall()` in a fixed-point
 * loop and runs filter+score between iterations. `shouldRun` is therefore
 * invoked at the start of every iteration and must converge to false
 * eventually — strategies wanting single-shot opt in by checking
 * `!context.strategiesRun.includes(this.name)`; strategies wanting to fire
 * across multiple iterations (N-shot) just don't add that guard. The
 * orchestrator caps total iterations as a safety net for misbehaving
 * `shouldRun` predicates that never converge.
 */
export interface RecallStrategy {
  readonly name: "fuzzy" | "embedding" | "web";
  /**
   * Should this strategy run on this iteration, given the current context?
   * Called once per recall iteration. Must converge to false eventually
   * (typically by reading `context.strategiesRun` to know prior fires, or by
   * consulting other context fields populated by earlier iterations like
   * `context.scoring`).
   */
  shouldRun(context: ResolutionContext): boolean;
  /** Produce candidates and (for `web`) write evidence into the context. The
   *  orchestrator merges the returned list into `context.candidates`. */
  recall(context: ResolutionContext): Promise<SlimCandidate[]>;
}

/** DI token for the recall strategy array. The module registers strategies as
 *  providers and exposes them via this token. */
export const RECALL_STRATEGIES = Symbol("RECALL_STRATEGIES");

/**
 * Decision strategies pick a final outcome from the scored, filtered candidate
 * pool plus thread context + evidence.
 *
 * The orchestrator passes the caller-supplied `threadContext` separately so the
 * persisted `ResolutionContext` doesn't carry it (caller-owned, not part of
 * the search artifact).
 */
export interface DecisionStrategy {
  decide(
    context: ResolutionContext,
    threadContext?: ResolutionThreadContext,
    traceCollector?: (data: ChatTraceData) => void,
    logContext?: Record<string, string>,
  ): Promise<FinalDecision>;
}

/** DI token for the decision strategy (single-impl by default). */
export const DECISION_STRATEGY = Symbol("DECISION_STRATEGY");
