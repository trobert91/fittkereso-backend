import { Inject, Injectable } from '@nestjs/common';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import type { ResolutionContext } from '../models/resolution-context';
import type { SlimCandidate, CandidateFunnel } from '../models/slim-types';
import {
  RECALL_STRATEGIES,
  type RecallStrategy,
} from '../models/strategy-types';

const MAX_CANDIDATES_DEFAULT = 50;

/**
 * Recall orchestrator. Iterates registered `RecallStrategy[]` once per call,
 * asking each one to run (gated by `strategy.shouldRun(ctx)`), and merges the
 * results.
 *
 * Strategies are evaluated sequentially in registration order so a strategy's
 * `shouldRun` can branch on candidates produced by earlier strategies within
 * the same call (e.g. `EmbeddingRecallStrategy.shouldRun` checks
 * `context.candidates.length` on its first iteration, which reflects what
 * fuzzy just merged in).
 *
 * The orchestrator (`ResolutionService`) calls `recall()` in a fixed-point
 * loop until no strategy fires — this method only handles a single pass.
 * Funnel counters are additive across calls so multiple invocations sum to the
 * total per-source hit count for the search.
 *
 * Final cleanup per call:
 *  - dedupe by productId (keeping the higher matchScore stash, when present)
 *  - drop `input.referenceProductId` from the pool (the reference itself can
 *    never be the answer in a variant search)
 *  - cap at `search.maxCandidates`
 */
@Injectable()
export class RecallService {
  constructor(
    @Inject(RECALL_STRATEGIES) private readonly strategies: RecallStrategy[],
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  async recall(context: ResolutionContext): Promise<void> {
    const maxCandidates =
      this.dynamicConfig.search?.maxCandidates ?? MAX_CANDIDATES_DEFAULT;
    // Initialize from the prior funnel (when present) so hits accumulate across
    // calls. A strategy that fires N times adds to its bucket N times.
    const hitsBySource: Record<RecallStrategy['name'], number> = {
      fuzzy: context.recallFunnel?.fuzzyHits ?? 0,
      embedding: context.recallFunnel?.embeddingHits ?? 0,
      web: context.recallFunnel?.webHits ?? 0,
    };
    const merged = new Map<string, SlimCandidate>();
    for (const existing of context.candidates) {
      merged.set(existing.productId, existing);
    }

    for (const strategy of this.strategies) {
      if (!strategy.shouldRun(context)) continue;
      try {
        const produced = await strategy.recall(context);
        hitsBySource[strategy.name] += produced.length;
        context.strategiesRun.push(strategy.name);
        for (const candidate of produced) {
          const existing = merged.get(candidate.productId);
          if (!existing) {
            merged.set(candidate.productId, candidate);
            continue;
          }
          // Prefer the existing entry's scoring data (matchScore + components)
          // when present; otherwise take the new candidate's metadata.
          if (
            (existing.matchScore ?? -Infinity) <
            (candidate.matchScore ?? -Infinity)
          ) {
            merged.set(candidate.productId, candidate);
          }
        }
        // Merge after each strategy so subsequent strategies see the running pool
        // via `context.candidates.length` (EmbeddingRecallStrategy's shouldRun
        // relies on this on the first iteration).
        context.candidates = Array.from(merged.values());
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        context.errors.push({
          phase: 'recall',
          message,
          detail: strategy.name,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const afterDedupe = merged.size;

    const referenceProductId = context.input.referenceProductId;
    if (referenceProductId && merged.has(referenceProductId)) {
      merged.delete(referenceProductId);
    }
    let pool = Array.from(merged.values());
    const afterReferenceExclusion = pool.length;

    if (pool.length > maxCandidates) {
      pool = pool
        .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
        .slice(0, maxCandidates);
    }

    context.candidates = pool;
    const funnel: CandidateFunnel = {
      fuzzyHits: hitsBySource.fuzzy,
      embeddingHits: hitsBySource.embedding,
      webHits: hitsBySource.web,
      afterDedupe,
      afterReferenceExclusion,
    };
    context.recallFunnel = funnel;
  }
}
