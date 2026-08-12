import { Inject, Injectable } from '@nestjs/common';
import { ChatTraceData } from '@fittkereso-backend/debug';
import type {
  ResolutionContext,
  FinalDecision,
} from '../models/resolution-context';
import {
  DECISION_STRATEGY,
  type DecisionStrategy,
} from '../models/strategy-types';
import { QualityGatesService } from '../matching/quality-gates.service';
import type {
  CategoryMatchConfig,
  ParsedModelCode,
} from '../matching/input-normalization.service';

/**
 * Decision stage. Bridges the scoring output to a `FinalDecision`.
 *
 * Branching:
 *  - No recall candidates                            → matcher_reject/no_qualifying_candidates
 *  - Matcher path produces ≥ 1 candidate(s) above
 *    `max(acceptThreshold, topScore − ambiguityGap)` → matcher_accept (skip LLM)
 *  - Matcher empty + web search ran                  → DecisionStrategy (LLM)
 *  - Matcher empty + web search did NOT run          → matcher_reject/no_candidates_above_threshold
 *
 * Writes the resulting `FinalDecision` onto `ctx.decision`.
 */
@Injectable()
export class DecisionService {
  constructor(
    @Inject(DECISION_STRATEGY)
    private readonly decisionStrategy: DecisionStrategy,
    private readonly qualityGates: QualityGatesService,
  ) {}

  async decide(
    context: ResolutionContext,
    traceCollector?: (data: ChatTraceData) => void,
    logContext?: Record<string, string>,
  ): Promise<void> {
    // Case 0: no recall candidates at all → matcher_reject (LLM has nothing).
    if (context.candidates.length === 0) {
      context.decision = {
        kind: 'matcher_reject',
        confidence: 0,
        reason: 'no_qualifying_candidates',
        selectedCandidates: [],
        evidenceSummary: 'no candidates after recall + filter',
      };
      return;
    }

    // Matcher path — return ALL candidates within the gap of the top score
    // and above the mode-aware accept floor. No best/second binary; the gate
    // operates per-candidate.
    const acceptable = this.runMatcherFilter(context);

    if (acceptable.length > 0) {
      context.decision = {
        kind: 'matcher_accept',
        confidence: acceptable[0].score,
        reason: 'matcher_accept',
        selectedCandidates: acceptable.map((match, index) => ({
          candidateId: match.candidateId,
          confidence: match.score,
          reason:
            index === 0
              ? 'matcher_accept_best'
              : 'matcher_accept_above_threshold',
        })),
        evidenceSummary:
          acceptable.length === 1
            ? `matcher accepted "${acceptable[0].alias}" with score ${acceptable[0].score}`
            : `matcher accepted ${acceptable.length} candidate(s) above effective floor (top score ${acceptable[0].score})`,
      };
      return;
    }

    // Matcher returned nothing above the floor. The LLM is only worth running
    // when web search ran (it brings new evidence the matcher already saw).
    // Otherwise short-circuit to matcher_reject — the comment's mention couldn't
    // be resolved, downstream validation picks it up via unresolved_after_search.
    const webSearchRan = context.strategiesRun.includes('web');
    const shouldRunLlm = context.options.webSearchEnabled && webSearchRan;

    if (!shouldRunLlm) {
      context.decision = {
        kind: 'matcher_reject',
        confidence: 0,
        reason: 'no_candidates_above_threshold',
        selectedCandidates: [],
        evidenceSummary: `matcher returned ${context.candidates.length} candidate(s), none above the effective floor`,
      };
      return;
    }

    // LLM path — matcher rejected everything but web search ran and produced
    // candidates. Let the LLM disambiguate.
    let decision: FinalDecision;
    try {
      decision = await this.decisionStrategy.decide(
        context,
        traceCollector,
        logContext,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      context.errors.push({
        phase: 'decision',
        message,
        timestamp: new Date().toISOString(),
      });
      decision = {
        kind: 'llm_unresolved',
        confidence: 0,
        reason: 'decision_strategy_error',
        selectedCandidates: [],
        evidenceSummary: message,
      };
    }

    context.decision = decision;
  }

  /** Run the per-candidate accept filter. Falls back to an empty array when the
   *  scoring stage didn't run (no matches recorded) — callers treat that the
   *  same as "no candidates above threshold". */
  private runMatcherFilter(context: ResolutionContext) {
    const matches = context.scoringMatches;
    if (!matches || matches.length === 0) return [];
    const inputParsed = context.scoringInputParsed as
      | ParsedModelCode
      | undefined;
    const matchConfig = context.scoringMatchConfig as
      | CategoryMatchConfig
      | undefined;
    if (!inputParsed || !matchConfig) return [];
    return this.qualityGates.filterAcceptable(
      matches,
      inputParsed,
      context.options,
      matchConfig,
    );
  }
}
