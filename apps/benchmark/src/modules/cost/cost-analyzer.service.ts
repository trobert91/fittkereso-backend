import { Injectable } from '@nestjs/common';
import { CandidateAggregate } from '../execution/candidate-aggregate.types';
import { JudgeVerdict } from '../judge/llm-judge.service';
import { ResolvedSubtreeCase } from '../scenario/scenario.types';

/**
 * One per-subtree slice of execution results. Used as input to all the
 * scenario-level rollups in this service.
 */
export interface SubtreeReportInput {
  subtreeCase: ResolvedSubtreeCase;
  /** Per-candidate aggregates for THIS subtree (not rolled up across subtrees yet). */
  aggregates: CandidateAggregate[];
  /** Verdict from the judge call scoped to this subtree, or undefined. */
  judge?: JudgeVerdict;
}

export interface CostSummary {
  scenarioId: string;
  totalUsd: number;
  byCandidate: Record<
    string,
    { runs: number; totalUsd: number; meanUsd: number; p95Usd: number }
  >;
  /**
   * Per-subtree cost rollup. `byCandidate[candidateId]` is the candidate's
   * total spend on that subtree (sum across the candidate's N runs there).
   */
  bySubtree: Record<
    string,
    { totalUsd: number; byCandidate: Record<string, number> }
  >;
  judgeUsd: number;
  byCostLabel: string;
}

export interface ParetoEntry {
  candidateId: string;
  /** Mean of per-subtree judge scores. null when no judge ran or all failed. */
  judgeScore: number | null;
  successRate: number;
  topFailureReason: string | null;
  mustContainPassRate: number;
  meanCost: number;
  dominatedBy: string | null;
  paretoOptimal: boolean;
}

/**
 * Per-candidate aggregate rolled up across every subtree of the scenario.
 * Mirrors `CandidateAggregate` but with means / sums computed across subtrees,
 * not just across the N runs of one subtree.
 */
export interface CandidateScenarioAggregate {
  candidateId: string;
  model: string;
  /** Total runs across all subtrees (== N × subtreeCount). */
  totalRuns: number;
  successes: number;
  successRate: number;
  failuresByReason: {
    providerError: number;
    emptyOrTruncated: number;
    notJsonParseable: number;
    schemaInvalid: number;
    deterministicCheckFail: number;
  };
  cost: { total: number; mean: number; p95: number };
  latencyMeanSec: number;
  /** Mean of per-subtree judge mean-scores. null when no judging happened. */
  judgeScore: number | null;
  mustContainPassRate: number;
  mustNotContainPassRate: number;
}

@Injectable()
export class CostAnalyzerService {
  // ─── Cost summary ──────────────────────────────────────────────────────────

  buildCostSummary(
    scenarioId: string,
    subtreeReports: SubtreeReportInput[],
  ): CostSummary {
    const byCandidate: CostSummary['byCandidate'] = {};
    const bySubtree: CostSummary['bySubtree'] = {};

    let candidateTotal = 0;
    let judgeUsd = 0;

    for (const report of subtreeReports) {
      const subtreeLabel = report.subtreeCase.label;
      const subtreeByCandidate: Record<string, number> = {};
      let subtreeTotal = 0;

      for (const aggregate of report.aggregates) {
        const cost = aggregate.cost.total;
        subtreeTotal += cost;
        subtreeByCandidate[aggregate.candidateId] = cost;

        // Accumulate into the per-candidate scenario rollup.
        const slot =
          byCandidate[aggregate.candidateId] ??
          (byCandidate[aggregate.candidateId] = {
            runs: 0,
            totalUsd: 0,
            meanUsd: 0,
            p95Usd: 0,
          });
        slot.runs += aggregate.runs.length;
        slot.totalUsd += cost;
        // p95 across subtrees is approximated as the max per-subtree p95 — exact
        // p95 across all runs would require keeping all individual cost samples,
        // not worth the complexity for an informational metric.
        slot.p95Usd = Math.max(slot.p95Usd, aggregate.cost.p95);
      }

      bySubtree[subtreeLabel] = {
        totalUsd: subtreeTotal,
        byCandidate: subtreeByCandidate,
      };
      candidateTotal += subtreeTotal;
      if (report.judge) {
        judgeUsd += report.judge.cost;
      }
    }

    // Fill in mean now that totals are known.
    for (const slot of Object.values(byCandidate)) {
      slot.meanUsd = slot.runs === 0 ? 0 : slot.totalUsd / slot.runs;
    }

    return {
      scenarioId,
      totalUsd: candidateTotal + judgeUsd,
      byCandidate,
      bySubtree,
      judgeUsd,
      byCostLabel: `benchmark:${scenarioId}:%`,
    };
  }

  // ─── Per-candidate scenario aggregate ──────────────────────────────────────

  buildCandidateScenarioAggregates(
    subtreeReports: SubtreeReportInput[],
  ): CandidateScenarioAggregate[] {
    if (subtreeReports.length === 0) return [];

    // Use the first subtree report as the canonical candidate ordering.
    const candidateIds = subtreeReports[0].aggregates.map((a) => a.candidateId);

    return candidateIds.map((candidateId) => {
      const perSubtreeAggregates: CandidateAggregate[] = subtreeReports.map(
        (r) => {
          const a = r.aggregates.find((x) => x.candidateId === candidateId);
          if (!a) {
            throw new Error(
              `CostAnalyzer: candidate ${candidateId} missing from subtree ${r.subtreeCase.label} aggregates`,
            );
          }
          return a;
        },
      );

      const model = perSubtreeAggregates[0].model;
      const totalRuns = perSubtreeAggregates.reduce(
        (acc, a) => acc + a.runs.length,
        0,
      );
      const successes = perSubtreeAggregates.reduce(
        (acc, a) => acc + a.reliability.successes,
        0,
      );
      const failuresByReason = {
        providerError: 0,
        emptyOrTruncated: 0,
        notJsonParseable: 0,
        schemaInvalid: 0,
        deterministicCheckFail: 0,
      };
      for (const a of perSubtreeAggregates) {
        for (const [reason, count] of Object.entries(
          a.reliability.failures.byReason,
        )) {
          failuresByReason[reason as keyof typeof failuresByReason] += count;
        }
      }

      const totalCost = perSubtreeAggregates.reduce(
        (acc, a) => acc + a.cost.total,
        0,
      );
      const meanCost = totalRuns === 0 ? 0 : totalCost / totalRuns;
      const p95Cost = Math.max(
        ...perSubtreeAggregates.map((a) => a.cost.p95),
      );
      const latencyMeanSec =
        perSubtreeAggregates.reduce(
          (acc, a) => acc + a.latency.meanSec * a.runs.length,
          0,
        ) / Math.max(1, totalRuns);

      // Judge score = mean across subtrees. Each subtree contributes one
      // candidate-mean (the mean of all numeric scores the judge emitted for
      // that candidate on that subtree).
      const perSubtreeJudgeMeans: number[] = [];
      for (const report of subtreeReports) {
        if (!report.judge) continue;
        const judged = report.judge.candidates.find(
          (c) => c.candidateId === candidateId,
        );
        if (!judged) continue;
        const values = Object.values(judged.scores).filter(
          (v) => typeof v === 'number',
        ) as number[];
        if (values.length === 0) continue;
        perSubtreeJudgeMeans.push(
          values.reduce((a, b) => a + b, 0) / values.length,
        );
      }
      const judgeScore =
        perSubtreeJudgeMeans.length === 0
          ? null
          : perSubtreeJudgeMeans.reduce((a, b) => a + b, 0) /
            perSubtreeJudgeMeans.length;

      // mustContain / mustNotContain pass rates: weight by run-count per
      // subtree so a candidate that fails 5/5 on one subtree and 0/5 on
      // another shows up at 50%, not 100%.
      const checkAggregate = this.weightedCheckPassRate(perSubtreeAggregates);

      return {
        candidateId,
        model,
        totalRuns,
        successes,
        successRate: totalRuns === 0 ? 0 : successes / totalRuns,
        failuresByReason,
        cost: { total: totalCost, mean: meanCost, p95: p95Cost },
        latencyMeanSec,
        judgeScore,
        mustContainPassRate: checkAggregate.mustContain,
        mustNotContainPassRate: checkAggregate.mustNotContain,
      };
    });
  }

  // ─── Pareto ────────────────────────────────────────────────────────────────

  /**
   * Build the Pareto comparison table from the scenario-level aggregates.
   * A candidate is "dominated" iff some other candidate beats it on all of:
   * judge score (if any), success rate, mean cost (lower wins).
   */
  buildPareto(scenarioAggregates: CandidateScenarioAggregate[]): ParetoEntry[] {
    const entries: ParetoEntry[] = scenarioAggregates.map((agg) => ({
      candidateId: agg.candidateId,
      judgeScore: agg.judgeScore,
      successRate: agg.successRate,
      topFailureReason: this.topFailureReason(agg.failuresByReason),
      mustContainPassRate: agg.mustContainPassRate,
      meanCost: agg.cost.mean,
      dominatedBy: null,
      paretoOptimal: true,
    }));

    for (const entry of entries) {
      for (const other of entries) {
        if (entry === other) continue;
        if (this.dominates(other, entry)) {
          entry.dominatedBy = other.candidateId;
          entry.paretoOptimal = false;
          break;
        }
      }
    }

    return entries;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private dominates(a: ParetoEntry, b: ParetoEntry): boolean {
    const aQuality = a.judgeScore ?? 0;
    const bQuality = b.judgeScore ?? 0;

    const qualityAtLeast = aQuality >= bQuality;
    const reliabilityAtLeast = a.successRate >= b.successRate;
    const costAtMost = a.meanCost <= b.meanCost;

    if (!qualityAtLeast || !reliabilityAtLeast || !costAtMost) return false;

    const qualityBetter = aQuality > bQuality;
    const reliabilityBetter = a.successRate > b.successRate;
    const costBetter = a.meanCost < b.meanCost;
    return qualityBetter || reliabilityBetter || costBetter;
  }

  private weightedCheckPassRate(
    perSubtree: CandidateAggregate[],
  ): { mustContain: number; mustNotContain: number } {
    let mustContainNum = 0;
    let mustContainDen = 0;
    let mustNotContainNum = 0;
    let mustNotContainDen = 0;
    for (const a of perSubtree) {
      const runs = a.runs.length;
      mustContainNum += a.deterministicChecks.aggregate.mustContainPassRate * runs;
      mustContainDen += runs;
      mustNotContainNum +=
        a.deterministicChecks.aggregate.mustNotContainPassRate * runs;
      mustNotContainDen += runs;
    }
    return {
      mustContain: mustContainDen === 0 ? 1 : mustContainNum / mustContainDen,
      mustNotContain:
        mustNotContainDen === 0 ? 1 : mustNotContainNum / mustNotContainDen,
    };
  }

  private topFailureReason(
    byReason: { [k: string]: number },
  ): string | null {
    const entries = Object.entries(byReason)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a);
    if (entries.length === 0) return null;
    return `${entries[0][0]} (${entries[0][1]})`;
  }
}
