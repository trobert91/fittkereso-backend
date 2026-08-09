import { Injectable } from "@nestjs/common";
import { CustomLogger } from "@ebike-backend/logger";
import {
  ResolvedCandidate,
  ResolvedSubtreeCase,
  Scenario,
} from "../scenario/scenario.types";
import { PhaseInput } from "../input/input.types";
import {
  CandidateRunResult,
  PhaseRunner,
} from "../phases/phase-runner.interface";
import {
  DeterministicChecksService,
  DeterministicCheckResult,
} from "../judge/deterministic-checks.service";
import { CandidateAggregate } from "./candidate-aggregate.types";

/**
 * Drives N runs for one candidate, runs deterministic checks per run, then
 * aggregates cost/latency/reliability/quality stats. Concurrency-bounded so a
 * single candidate doesn't fan out beyond `runs.concurrency` parallel calls.
 */
@Injectable()
export class CandidateExecutor {
  private readonly logger = new CustomLogger(CandidateExecutor.name);

  constructor(
    private readonly deterministicChecks: DeterministicChecksService,
  ) {}

  async execute(
    runner: PhaseRunner,
    input: PhaseInput,
    candidate: ResolvedCandidate,
    scenario: Scenario,
    subtreeCase: ResolvedSubtreeCase,
    runsOverride?: number,
  ): Promise<CandidateAggregate> {
    const runCount = runsOverride ?? scenario.runs.perCandidate;

    this.logger.log(
      `Executing candidate ${candidate.id} on ${subtreeCase.label} (${runCount} runs, model=${candidate.model})`,
    );

    // Fan out all N runs in parallel — the LlmCallGate (one global semaphore
    // with `runs.maxInFlight` permits, applied inside `runner.run`) is the
    // only thing throttling actual HTTP request rate.
    const runs: CandidateRunResult[] = await Promise.all(
      Array.from({ length: runCount }, (_, runIndex) =>
        runner.run(input, candidate, runIndex, {
          scenarioId: scenario.id,
          subtreeLabel: subtreeCase.label,
        }),
      ),
    );

    // Per-run deterministic checks. Downgrade succeeded → false when checks fail.
    // Use per-subtree expectations (the case carries either its own override or
    // the scenario-level fallback resolved at load time).
    const checkResults: DeterministicCheckResult[] = runs.map((run) => {
      // Skip checks for runs that already errored upstream — those failures
      // already have their own classification.
      if (!run.succeeded) {
        return {
          schemaCheck: { ran: false, passed: false, errors: [] },
          mustContain: [],
          mustNotContain: [],
          allPassed: false,
        };
      }
      const result = this.deterministicChecks.evaluate(
        run,
        subtreeCase.expectations,
      );
      if (!result.allPassed) {
        run.succeeded = false;
        run.failureReason = run.failureReason ?? "deterministicCheckFail";
        run.failureMessage =
          run.failureMessage ?? this.summarizeCheckFailure(result);
      }
      return result;
    });

    return this.buildAggregate(candidate, runs, checkResults);
  }

  // ─── Aggregation ───────────────────────────────────────────────────────────

  private buildAggregate(
    candidate: ResolvedCandidate,
    runs: CandidateRunResult[],
    checks: DeterministicCheckResult[],
  ): CandidateAggregate {
    const costs = runs.map((r) => r.cost ?? 0);
    const latencies = runs.map((r) => r.executionTimeInSec);
    const promptTokens = runs.map((r) => r.usage.promptTokens);
    const completionTokens = runs.map((r) => r.usage.completionTokens);
    const cachedTokens = runs.map((r) => r.usage.cachedTokens);

    const failuresByReason = {
      providerError: 0,
      emptyOrTruncated: 0,
      notJsonParseable: 0,
      schemaInvalid: 0,
      deterministicCheckFail: 0,
    };
    const detailsPerRun: CandidateAggregate["reliability"]["failures"]["detailsPerRun"] =
      [];

    let successes = 0;
    for (const run of runs) {
      if (run.succeeded) {
        successes++;
        continue;
      }
      const reason = run.failureReason ?? "providerError";
      failuresByReason[reason]++;
      detailsPerRun.push({
        runIndex: run.runIndex,
        reason,
        message: run.failureMessage ?? "<no message>",
      });
    }

    const mustContainTotal = checks.reduce(
      (acc, c) => acc + c.mustContain.length,
      0,
    );
    const mustContainPassed = checks.reduce(
      (acc, c) => acc + c.mustContain.filter((m) => m.passed).length,
      0,
    );
    const mustNotContainTotal = checks.reduce(
      (acc, c) => acc + c.mustNotContain.length,
      0,
    );
    const mustNotContainPassed = checks.reduce(
      (acc, c) => acc + c.mustNotContain.filter((m) => m.passed).length,
      0,
    );

    return {
      candidateId: candidate.id,
      model: candidate.model,
      runs,
      cost: {
        total: sum(costs),
        mean: mean(costs),
        min: Math.min(...costs),
        max: Math.max(...costs),
        p95: percentile(costs, 0.95),
      },
      latency: {
        meanSec: mean(latencies),
        p95Sec: percentile(latencies, 0.95),
      },
      usage: {
        meanPromptTokens: mean(promptTokens),
        meanCompletionTokens: mean(completionTokens),
        meanCachedTokens: mean(cachedTokens),
      },
      reliability: {
        totalRuns: runs.length,
        successes,
        failures: {
          total: runs.length - successes,
          byReason: failuresByReason,
          detailsPerRun,
        },
        successRate: runs.length === 0 ? 0 : successes / runs.length,
      },
      deterministicChecks: {
        perRun: checks,
        aggregate: {
          mustContainPassRate:
            mustContainTotal === 0 ? 1 : mustContainPassed / mustContainTotal,
          mustNotContainPassRate:
            mustNotContainTotal === 0
              ? 1
              : mustNotContainPassed / mustNotContainTotal,
        },
      },
      representativeRunIndex: this.pickRepresentativeRun(runs, costs),
    };
  }

  /**
   * Prefer a run that succeeded and whose cost is closest to the median.
   * Falls back to any run.
   */
  private pickRepresentativeRun(
    runs: CandidateRunResult[],
    costs: number[],
  ): number {
    if (runs.length === 0) return 0;
    const successfulIndices = runs
      .map((r, i) => (r.succeeded ? i : -1))
      .filter((i) => i >= 0);
    const candidates =
      successfulIndices.length > 0 ? successfulIndices : runs.map((_, i) => i);

    const costsForCandidates = candidates.map((i) => costs[i]);
    const medianCost = median(costsForCandidates);
    let best = candidates[0];
    let bestDiff = Math.abs(costs[best] - medianCost);
    for (const i of candidates) {
      const diff = Math.abs(costs[i] - medianCost);
      if (diff < bestDiff) {
        best = i;
        bestDiff = diff;
      }
    }
    return best;
  }

  private summarizeCheckFailure(result: DeterministicCheckResult): string {
    const fragments: string[] = [];
    if (result.schemaCheck.ran && !result.schemaCheck.passed) {
      fragments.push(`schema: ${result.schemaCheck.errors.join("; ")}`);
    }
    for (const check of result.mustContain.filter((c) => !c.passed)) {
      fragments.push(`mustContain failed: ${check.reason}`);
    }
    for (const check of result.mustNotContain.filter((c) => !c.passed)) {
      fragments.push(`mustNotContain failed: ${check.reason}`);
    }
    return fragments.join(" | ");
  }
}

// ─── Stats helpers ───────────────────────────────────────────────────────────

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * p) - 1),
  );
  return sorted[idx];
}
