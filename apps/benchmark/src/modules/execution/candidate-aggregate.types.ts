import { CandidateRunResult } from '../phases/phase-runner.interface';
import { DeterministicCheckResult } from '../judge/deterministic-checks.service';

export interface CandidateAggregate {
  candidateId: string;
  model: string;
  runs: CandidateRunResult[];
  cost: { total: number; mean: number; min: number; max: number; p95: number };
  latency: { meanSec: number; p95Sec: number };
  usage: {
    meanPromptTokens: number;
    meanCompletionTokens: number;
    meanCachedTokens: number;
  };

  reliability: {
    totalRuns: number;
    successes: number;
    failures: {
      total: number;
      byReason: {
        providerError: number;
        emptyOrTruncated: number;
        notJsonParseable: number;
        schemaInvalid: number;
        deterministicCheckFail: number;
      };
      detailsPerRun: Array<{
        runIndex: number;
        reason: string;
        message: string;
      }>;
    };
    successRate: number;
  };

  deterministicChecks: {
    perRun: DeterministicCheckResult[];
    aggregate: {
      mustContainPassRate: number;
      mustNotContainPassRate: number;
    };
  };

  representativeRunIndex: number;
}
