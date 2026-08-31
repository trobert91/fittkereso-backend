import { Injectable } from '@nestjs/common';
import {
  ProductResolutionFlow,
  ResolutionVerdict,
  type ProductResolutionCandidateRecord,
  type ProductResolutionDecisionSnapshot,
  type SpecMatchDetails,
} from '@fittkereso-backend/database';
import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import { isEmpty, isNumber, maxBy, pickBy } from 'lodash';
import {
  deriveSystemAssertion,
  outcomeTension,
  type SystemAssertion,
} from './outcome-tension';

export interface ResolutionConfidenceParams {
  flow: ProductResolutionFlow;
  similarityScore: number;
  /** `decisions[0].verdict` — see `deriveSystemAssertion`. */
  seedVerdict?: ResolutionVerdict;
  resolvedProductId?: string | null;
  decisionSnapshot?: ProductResolutionDecisionSnapshot;
  candidates?: ProductResolutionCandidateRecord[];
  specMatchDetails?: SpecMatchDetails;
  scoring?: { bestScore?: number; secondScore?: number };
  /** Recording threshold, to undo the truncation of the score range. */
  floor?: number;
  /** Runtime overrides for `CONFIDENCE_WEIGHTS`; anything omitted keeps its
   *  default. Passed in rather than read here so this service stays pure and
   *  its caller owns the config dependency. */
  weights?: Partial<ConfidenceWeights>;
}

/** One piece of evidence, read in the direction of the assertion made. */
interface ConfidenceSignal {
  key: keyof ConfidenceWeights;
  /** 0–1. 1 = this evidence supports the assertion the system made. */
  value: number;
}

/** A signal with the weight it carries, attached by key so a component can
 *  never be scored against the wrong one. */
export interface ConfidenceComponent extends ConfidenceSignal {
  weight: number;
}

export interface ResolutionConfidenceBreakdown {
  assertion: SystemAssertion;
  components: ConfidenceComponent[];
  confidence: number;
}

/**
 * Default weights, read from `resolution.json` so the shipped defaults and the
 * dynamic-config overrides describe the same thing in one place.
 *
 * They are the obvious calibration target once there is enough review history to
 * fit them against (see §4.1 of `docs/ResolutionConfidenceScoreAnalysis.md` —
 * these are informed guesses, not measurements), which is why they are
 * overridable at runtime rather than compiled in.
 */
export const CONFIDENCE_WEIGHTS = RESOLUTION_DEFAULTS.priority.weights
  .confidence satisfies Record<string, number>;

export type ConfidenceWeights = typeof CONFIDENCE_WEIGHTS;

/** Below this many comparable specs the ratio is too noisy to weigh. */
const MIN_COMPARABLE_SPECS = 1;

/**
 * How sure are we that the outcome was correct — **whichever outcome it was**.
 *
 * The point of this service is symmetry. The value it replaces was
 * `max(selectedCandidates[*].confidence)`, which is `0` for every rejection
 * because a rejection has no selected candidate: "confidently not a match" and
 * "no idea" produced the same number, and anything built on top inherited that.
 *
 * Here a rejection scores *high* when the evidence clearly says the two things
 * are different — specs clash, gates failed, they do not look alike — and *low*
 * when it was a near-miss. The LLM's own confidence is one modestly-weighted
 * input rather than the answer, which is what puts `matcher_accept` at 90 and
 * `llm_resolved` at 90 on the same scale.
 *
 * Components that cannot speak to a given row are dropped and the remaining
 * weights renormalized, rather than contributing a misleading zero — that
 * distinction is the whole fix.
 */
@Injectable()
export class ResolutionConfidenceService {
  public compute(params: ResolutionConfidenceParams): number {
    return this.explain(params).confidence;
  }

  /** `compute` with the working shown — used by tests, and available for
   *  debugging a row that scored surprisingly. */
  public explain(
    params: ResolutionConfidenceParams,
  ): ResolutionConfidenceBreakdown {
    const assertion = deriveSystemAssertion(params);
    const candidate = this.subjectCandidate(params);
    const weights = resolveWeights(params.weights);

    const components = [
      this.outcomeAgreement(params),
      this.specAgreement(params, assertion, candidate),
      this.gateAgreement(assertion, candidate),
      this.corroboration(assertion, candidate),
      this.margin(params, assertion),
      this.selfReport(params, assertion),
    ]
      .filter((signal): signal is ConfidenceSignal => !!signal)
      .map((signal) => ({ ...signal, weight: weights[signal.key] }));

    return {
      assertion,
      components,
      confidence: Math.round(100 * weightedMean(components)),
    };
  }

  /**
   * The candidate the assertion is about: the one picked when a match was made,
   * otherwise the strongest one — the candidate that was rejected, which is what
   * a rejection's confidence is a claim about.
   */
  private subjectCandidate(
    params: ResolutionConfidenceParams,
  ): ProductResolutionCandidateRecord | undefined {
    const candidates = params.candidates ?? [];
    if (isEmpty(candidates)) return undefined;

    const pickedId = params.decisionSnapshot?.selectedCandidates?.[0]?.candidateId;
    const picked = pickedId
      ? candidates.find((entry) => entry.candidateId === pickedId)
      : undefined;

    return picked ?? maxBy(candidates, (entry) => entry.matchScore ?? 0);
  }

  /** Does the conclusion match how alike the two things look? Always applicable
   *  — every row has a score and an assertion. */
  private outcomeAgreement(
    params: ResolutionConfidenceParams,
  ): ConfidenceSignal {
    return { key: 'outcomeAgreement', value: 1 - outcomeTension(params) };
  }

  /**
   * Spec evidence, read in the direction of the assertion. The same
   * `primaryMismatches` that undermines a match *supports* a rejection — one
   * field, opposite meanings, which is why a single unsigned score cannot
   * express it.
   */
  private specAgreement(
    params: ResolutionConfidenceParams,
    assertion: SystemAssertion,
    candidate?: ProductResolutionCandidateRecord,
  ): ConfidenceSignal | undefined {
    const specs = params.specMatchDetails ?? candidate?.specMatchDetails;
    if (!specs || specs.comparableCount < MIN_COMPARABLE_SPECS) {
      return undefined;
    }

    const agreement = clamp01(specs.matchingCount / specs.comparableCount);
    const hasPrimaryClash = specs.primaryMismatches > 0;

    // A primary spec is identity-defining: one disagreement is near-decisive
    // evidence of difference, and outweighs any number of agreeing accessory
    // specs.
    const value =
      assertion === 'same'
        ? hasPrimaryClash
          ? Math.min(agreement, 0.2)
          : agreement
        : hasPrimaryClash
          ? Math.max(1 - agreement, 0.8)
          : 1 - agreement;

    return { key: 'specAgreement', value };
  }

  /** Gates passing supports a match; gates failing supports a rejection. */
  private gateAgreement(
    assertion: SystemAssertion,
    candidate?: ProductResolutionCandidateRecord,
  ): ConfidenceSignal | undefined {
    if (!candidate?.gates) return undefined;

    const { passed, failedGates } = candidate.gates;
    // More failed gates is stronger evidence of difference, with diminishing
    // returns — two failures is much more telling than one, five is not much
    // more telling than four.
    const failureStrength = passed
      ? 0
      : clamp01(0.5 + 0.25 * Math.min(failedGates?.length ?? 1, 2));

    return {
      key: 'gateAgreement',
      value:
        assertion === 'same' ? (passed ? 1 : 1 - failureStrength) : failureStrength,
    };
  }

  /**
   * Whether anything *independent of the name* backs the call.
   *
   * The match score is built almost entirely from name components
   * (`stringSimilarity`/`tokenOverlap`/`alphaMatch`, per `NAME_WEIGHTS` in
   * `ProductSimilarityService`); `specSimilarity` is explicitly excluded from
   * that formula and `aliasMatch` sits outside it. So those two are genuinely
   * separate evidence, and a high score with neither behind it is weaker than
   * the number suggests — two products whose names happen to look alike.
   */
  private corroboration(
    assertion: SystemAssertion,
    candidate?: ProductResolutionCandidateRecord,
  ): ConfidenceSignal | undefined {
    const components = candidate?.matchComponents;
    if (!components) return undefined;

    const support = Math.max(
      clamp01(components.specSimilarity),
      components.aliasMatch ? 1 : 0,
    );

    return {
      key: 'corroboration',
      // Independent support for sameness backs a match and undercuts a
      // rejection, so the reading flips with the assertion.
      value: assertion === 'same' ? support : 1 - support,
    };
  }

  /**
   * How clearly the winner beat the runner-up. Only meaningful for a match:
   * when nothing was picked, the gap between two also-rans says nothing about
   * whether rejecting both was right.
   *
   * Inapplicable when there is no runner-up at all — a single-candidate set
   * (every `duplicate_detection` row) would otherwise read as a maximally clear
   * win and silently inflate confidence.
   */
  private margin(
    params: ResolutionConfidenceParams,
    assertion: SystemAssertion,
  ): ConfidenceSignal | undefined {
    if (assertion !== 'same') return undefined;

    const best = params.scoring?.bestScore;
    const second = params.scoring?.secondScore;
    if (best === undefined || second === undefined) return undefined;

    return { key: 'margin', value: clamp01((best - second) / 100) };
  }

  /**
   * The decider's own opinion — weighted low on purpose, and dropped entirely on
   * a rejection.
   *
   * `decisionSnapshot.confidence` is `max(selectedCandidates[*].confidence)`,
   * which is `0` whenever nothing was selected. Reading that as "no confidence"
   * is precisely the bug this service exists to fix, so on a rejection the
   * component is *absent* rather than zero.
   */
  private selfReport(
    params: ResolutionConfidenceParams,
    assertion: SystemAssertion,
  ): ConfidenceSignal | undefined {
    if (assertion !== 'same') return undefined;

    const reported = params.decisionSnapshot?.confidence;
    if (reported === undefined || isEmpty(params.decisionSnapshot?.selectedCandidates)) {
      return undefined;
    }

    return { key: 'selfReport', value: clamp01(reported / 100) };
  }
}

/**
 * Coded defaults with runtime overrides laid over the top.
 *
 * Filtered to numbers because the overrides come from dynamic config, where a
 * hand-edited `null` or a stray string is a real possibility — and a
 * non-numeric weight would poison the mean rather than being ignored.
 */
function resolveWeights(
  overrides?: Partial<ConfidenceWeights>,
): ConfidenceWeights {
  return { ...CONFIDENCE_WEIGHTS, ...pickBy(overrides ?? {}, isNumber) };
}

/** Renormalizes over whichever components applied, so dropping one shifts the
 *  balance rather than dragging the score toward zero. */
function weightedMean(components: ConfidenceComponent[]): number {
  const totalWeight = components.reduce(
    (sum, component) => sum + component.weight,
    0,
  );
  if (totalWeight <= 0) return 0;

  const weighted = components.reduce(
    (sum, component) => sum + component.value * component.weight,
    0,
  );
  return clamp01(weighted / totalWeight);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
