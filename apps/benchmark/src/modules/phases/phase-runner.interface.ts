import { ResolvedCandidate, Phase } from '../scenario/scenario.types';
import { PhaseInput } from '../input/input.types';

// ─── Per-run failure taxonomy ────────────────────────────────────────────────

export type RunFailureReason =
  | 'providerError' // 5xx / rate limit / timeout / model-side error
  | 'emptyOrTruncated' // finishReason !== 'stop' or content was empty
  | 'notJsonParseable' // schema set but raw output wasn't valid JSON
  | 'schemaInvalid' // parsed but failed schema validation
  | 'deterministicCheckFail'; // mustContain / mustNotContain miss

// ─── Per-run result ──────────────────────────────────────────────────────────

export interface CandidateRunResult {
  candidateId: string;
  runIndex: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  rawContent: string;
  parsed: unknown | undefined;
  schemaValid: boolean;
  schemaErrors: string[];
  cost: number | undefined;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
  };
  executionTimeInSec: number;
  /** True iff: no error, parsed (when schema set), schemaValid, deterministic checks passed. Filled in by CandidateExecutor after deterministic checks run. */
  succeeded: boolean;
  failureReason?: RunFailureReason;
  failureMessage?: string;
}

// ─── Phase runner contract ───────────────────────────────────────────────────

export interface PhaseRunner {
  readonly phase: Phase;
  /**
   * Build prompts and execute one LLM call. The runner is responsible for
   * provider invocation, schema validation, and reporting cost/usage. It is
   * NOT responsible for deterministic checks or success classification — that's
   * the CandidateExecutor's job after this returns.
   */
  run(
    input: PhaseInput,
    candidate: ResolvedCandidate,
    runIndex: number,
    options: PhaseRunnerOptions,
  ): Promise<CandidateRunResult>;

  /** Build prompts only — used by --dry-run. */
  buildPrompts(
    input: PhaseInput,
    candidate: ResolvedCandidate,
  ): { systemPrompt: string; userPrompt: string };

  /**
   * Identifier embedded into AiChatRequest.costLabel.
   * Format: `benchmark:<scenarioId>:<subtreeLabel>:<candidateId>:<runIndex>`.
   * The subtree dimension lets `get_cost_analysis` queries drill down to a
   * single (subtree, candidate, run) tuple.
   */
  costLabelPrefix(
    scenarioId: string,
    subtreeLabel: string,
    candidateId: string,
    runIndex: number,
  ): string;
}

export interface PhaseRunnerOptions {
  scenarioId: string;
  /** Stable label for the active subtree (e.g. "subtree-3" or a custom label from the scenario). */
  subtreeLabel: string;
}
