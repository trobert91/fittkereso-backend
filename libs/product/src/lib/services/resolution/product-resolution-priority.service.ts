import { Injectable } from '@nestjs/common';
import {
  ProductResolutionStatus,
  ResolutionActionKind,
  type PriorityFactor,
  type ProductResolutionDecisionEntry,
  type ResolutionPriorityBreakdown,
} from '@fittkereso-backend/database';
import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import { isNumber, pickBy } from 'lodash';
import {
  ResolutionConfidenceService,
  type ResolutionConfidenceParams,
} from './resolution-confidence.service';

/** How many listings/offers count as "as bad as it gets" for blast radius. */
const BLAST_RADIUS_CAP = 40;

/** Impact never reaches zero: an uncertain decision stays visible even when it
 *  touches almost nothing, because "almost nothing" is still wrong. */
const IMPACT_FLOOR = 0.2;

/** Blast radius assumed when it has not been measured yet — see
 *  `blastRadiusMeasured`. Mid-range, so an unmeasured row neither leads the
 *  queue nor disappears from it before the sweep corrects it. */
const ASSUMED_BLAST_RADIUS = 0.5;

/** Default impact weights, read from `resolution.json` so the shipped defaults
 *  and the dynamic-config overrides are one description, not two. */
export const PRIORITY_WEIGHTS = RESOLUTION_DEFAULTS.priority.weights
  .impact satisfies Record<string, number>;

export type PriorityWeights = typeof PRIORITY_WEIGHTS;

/** Multiplier by workflow state — is this review work at all? */
export const STATUS_WEIGHTS: Record<ProductResolutionStatus, number> = {
  [ProductResolutionStatus.pending]: 1,
  // A failed action is broken and needs a human either way.
  [ProductResolutionStatus.failed]: 1,
  // Decided, but re-openable, so not zero.
  [ProductResolutionStatus.done]: 0.15,
  // Replaced by a newer row; there is nothing to decide.
  [ProductResolutionStatus.superseded]: 0,
};

/** Below this many days since the last sighting, no staleness penalty. */
const STALENESS_GRACE_DAYS = 30;
/** Penalty bottoms out here — a quiet listing is worth less, never worthless. */
const STALENESS_FLOOR = 0.5;
const STALENESS_SPAN_DAYS = 365;

export interface BlastRadius {
  sourceRecords: number;
  offers: number;
}

export interface ProductResolutionPriorityParams
  extends ResolutionConfidenceParams {
  status: ProductResolutionStatus;
  /** The latest decision that actually changed the catalog. */
  lastPerformed?: ProductResolutionDecisionEntry;
  lastSeenAt?: Date | string | null;
  /**
   * Listings and offers riding on the affected product(s). Omitted on the
   * scrape hot path, where counting them would cost a query per record — the
   * nightly sweep fills it in.
   */
  blastRadius?: BlastRadius;
  /** Runtime overrides for `PRIORITY_WEIGHTS`; anything omitted keeps its
   *  default. Passed in, like the confidence weights, so this service stays
   *  pure. */
  impactWeights?: Partial<PriorityWeights>;
}

/**
 * How important is it that a human looks at this row?
 *
 * `priority = 100 × uncertainty × impact × statusWeight`
 *
 * Multiplicative on purpose: either factor near zero should retire a row on its
 * own. A decision we are sure about needs no review however much rides on it,
 * and a decision touching nothing needs none however unsure we are. A weighted
 * sum would let a large blast radius drag a settled decision to the top of the
 * queue, which is exactly the noise this replaces.
 *
 * `uncertainty` is `1 − confidence`, taken from `ResolutionConfidenceService`
 * rather than recomputed. The two are definitionally inverse — one asks whether
 * the outcome was right, the other how likely it is wrong — so deriving them
 * separately would be the same weighting logic written twice, and the two copies
 * would drift. Priority deliberately has no spec/gate terms of its own; every
 * raw signal enters exactly once, through confidence.
 */
@Injectable()
export class ProductResolutionPriorityService {
  constructor(private readonly confidenceService: ResolutionConfidenceService) {}

  public compute(params: ProductResolutionPriorityParams): number {
    return this.explain(params).priority;
  }

  /** `compute` with the working shown — persisted as `priorityBreakdown` so a
   *  reviewer can see why a row leads the queue, and a wrong score can be traced
   *  to the term that caused it. */
  public explain(
    params: ProductResolutionPriorityParams,
  ): ResolutionPriorityBreakdown {
    const confidence = this.confidenceService.compute(params);
    const uncertainty = clamp01(1 - confidence / 100);

    const impactFactors = this.impactFactors(params);
    const impact =
      IMPACT_FLOOR + (1 - IMPACT_FLOOR) * weightedMean(impactFactors);

    const statusWeight =
      (STATUS_WEIGHTS[params.status] ?? 0) * this.staleness(params.lastSeenAt);

    return {
      priority: Math.round(100 * uncertainty * impact * statusWeight),
      uncertainty,
      impact,
      statusWeight,
      confidence,
      impactFactors,
      blastRadiusMeasured: !!params.blastRadius,
    };
  }

  private impactFactors(
    params: ProductResolutionPriorityParams,
  ): PriorityFactor[] {
    const weights: PriorityWeights = {
      ...PRIORITY_WEIGHTS,
      // Filtered to numbers: the overrides come from dynamic config, where a
      // hand-edited null would otherwise poison the mean.
      ...pickBy(params.impactWeights ?? {}, isNumber),
    };

    const values: Record<keyof PriorityWeights, number> = {
      blastRadius: params.blastRadius
        ? logScale(
            params.blastRadius.sourceRecords + params.blastRadius.offers,
            BLAST_RADIUS_CAP,
          )
        : ASSUMED_BLAST_RADIUS,
      actionKind: this.actionKindImpact(params.lastPerformed),
      mergeReach: this.mergeReach(params.lastPerformed),
    };

    return Object.entries(values).map(([key, value]) => ({
      key,
      value,
      weight: weights[key as keyof PriorityWeights],
    }));
  }

  /**
   * What is at stake in the action this row represents.
   *
   * An unperformed proposal scores highest: nothing has happened yet, and
   * accepting it *deletes a product*. That is the most consequential button in
   * the queue, and it is the duplicate-detection rows — which never merge on
   * their own — that carry it.
   */
  private actionKindImpact(
    lastPerformed?: ProductResolutionDecisionEntry,
  ): number {
    if (!lastPerformed) return 1;

    switch (lastPerformed.action.kind) {
      case ResolutionActionKind.merge:
        // Already merged: a product is gone and unpicking it means a split.
        return 0.9;
      case ResolutionActionKind.split:
        return 0.7;
      case ResolutionActionKind.create:
        // A new product that should not exist is how the catalog grows
        // duplicates — worse than a listing on the wrong product.
        return 0.6;
      case ResolutionActionKind.match:
        return 0.45;
      case ResolutionActionKind.none:
      default:
        return 0.3;
    }
  }

  /** How much a performed merge moved — recorded for reversal anyway, and a
   *  direct measure of how expensive undoing it would be. */
  private mergeReach(lastPerformed?: ProductResolutionDecisionEntry): number {
    const moved = lastPerformed?.action.sourceRecordIds?.length ?? 0;
    if (moved === 0) {
      // Nothing performed yet, or nothing moved. Neutral rather than zero: the
      // absence of a merge is not evidence that the row is unimportant.
      return 0.5;
    }
    return logScale(moved, BLAST_RADIUS_CAP);
  }

  /**
   * A row whose listing has not been re-scraped in a long time matters less —
   * the situation may no longer exist. Tapers rather than cliffs, and never
   * below `STALENESS_FLOOR`, so an old row sinks without becoming unreachable.
   */
  private staleness(lastSeenAt?: Date | string | null): number {
    if (!lastSeenAt) return 1;

    const seen = new Date(lastSeenAt).getTime();
    if (!Number.isFinite(seen)) return 1;

    const days = (Date.now() - seen) / MS_PER_DAY;
    if (days <= STALENESS_GRACE_DAYS) return 1;

    const decayed =
      1 - (days - STALENESS_GRACE_DAYS) / STALENESS_SPAN_DAYS;
    return Math.max(STALENESS_FLOOR, Math.min(1, decayed));
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Diminishing returns: 1 → 10 listings matters far more than 40 → 50. */
function logScale(count: number, cap: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return clamp01(Math.log1p(count) / Math.log1p(cap));
}

function weightedMean(factors: PriorityFactor[]): number {
  const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  if (totalWeight <= 0) return 0;

  const weighted = factors.reduce(
    (sum, factor) => sum + factor.value * factor.weight,
    0,
  );
  return clamp01(weighted / totalWeight);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
