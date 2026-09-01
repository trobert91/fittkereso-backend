import {
  ProductResolutionFlow,
  ProductResolutionStatus,
  type ProductResolutionCandidateRecord,
  type ResolutionReviewTrigger,
} from '@fittkereso-backend/database';
import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { isEmpty, isNil } from 'lodash';

export interface AiAutomationConfig {
  enabled: boolean;
  /**
   * Judge and record, act on nothing.
   *
   * The verdict still lands on the row — `aiReview`, `aiConfidence`, and an
   * advisory entry in the decision log — because a batch you cannot inspect row
   * by row is not the thing this flag exists to give you. What it withholds is
   * the catalog action, which is the only irreversible half.
   *
   * Overlaps `executeActions` deliberately: that one is the operator's standing
   * policy ("the AI does not act here"), this one is a per-run choice ("not on
   * this run"). Either being set is enough to keep the AI advisory.
   */
  dryRun: boolean;
  model: string;
  effort: string;
  /** Carry out a high-confidence recommendation at all. Off makes every verdict
   *  advisory — judged and recorded, but waiting on a human to apply it. */
  executeActions: boolean;
  /**
   * Allow the destructive half — merge and split — to be carried out.
   *
   * Its own switch, separate from `executeActions`, because the two authorise
   * very different things. Confirming a scrape-time resolution is bookkeeping;
   * merging two products deletes one. Being able to let the AI do the first
   * while it has not yet earned the second is the point.
   */
  executeDestructive: boolean;
  maxPerRun: number;
  minPriority: number;
  maxCostUsdPerRun: number;
  reReviewAfterDays: number;
}

export interface DeterministicAutomationConfig {
  enabled: boolean;
  /** Apply the rule during scraping, so a trusted row is never queued at all.
   *  Turning this off leaves only the nightly catch-up. */
  atRecordTime: boolean;
  /** Log what would be accepted without writing anything. */
  dryRun: boolean;
  minConfidence: number;
  maxPerRunNightly: number;
}

/** Everything the rule reads. Deliberately a plain shape rather than a
 *  `ProductResolution`, so the recorder can test a row that does not exist yet
 *  against exactly the same predicate the nightly pass applies to stored ones. */
export interface TrustRuleSubject {
  flow: ProductResolutionFlow;
  status?: ProductResolutionStatus;
  reviewedAt?: Date | null;
  decisionConfidence?: number | null;
  reviewTriggers?: ResolutionReviewTrigger[] | null;
  candidates?: ProductResolutionCandidateRecord[] | null;
}

/** Why a row was not trusted. Returned rather than logged inside the predicate
 *  so `dryRun` can report the real distribution of near-misses, which is what
 *  tells you whether `minConfidence` is set anywhere near right. */
export type TrustRuleRejection =
  | 'wrong_flow'
  | 'human_touched'
  | 'not_open'
  | 'unclassified'
  | 'triggered'
  | 'below_confidence'
  | 'no_candidates';

/**
 * May the deterministic path settle this row on its own?
 *
 * Every clause is a veto, and each one is load-bearing:
 *
 * - **`flow = product_resolution`** is the structural guarantee that accepting
 *   changes nothing in the catalog. Every row of this flow carries a seed entry
 *   with `actionPerformed: true` — the listing was already matched or a product
 *   was already created — so `ActionService.accept` takes its `lastPerformed`
 *   branch and records a confirmation. A `duplicate_detection` row is the
 *   opposite: nothing has happened yet and accepting *executes a merge*, which
 *   is never something a score alone should authorise. Those go to the AI, which
 *   reads the evidence first.
 * - **`reviewedAt IS NULL`** — never overrule a human. This is the rail that
 *   makes a reopened row permanently yours: automation cannot re-close it, and
 *   the only way it returns to the automated path is a rescrape changing the
 *   situation, which creates a fresh untouched row.
 * - **triggers `[]`, not null** — `null` means the sweep has never classified
 *   the row, and an unchecked row must never read as a clean one.
 * - **candidates non-empty** — belt and braces against a confidence derived from
 *   the absence of evidence. `ResolutionConfidenceService` no longer produces one
 *   (see its `outcomeAgreement`), but this rule is the last thing standing
 *   between a scoring regression and an auto-closed queue, so it does not
 *   delegate that check.
 *
 * Returns the first failing clause, in cheapest-first order.
 */
export function trustRuleRejection(
  subject: TrustRuleSubject,
  config: Pick<DeterministicAutomationConfig, 'minConfidence'>,
): TrustRuleRejection | undefined {
  if (subject.flow !== ProductResolutionFlow.product_resolution) {
    return 'wrong_flow';
  }
  if (subject.reviewedAt) return 'human_touched';

  // Unset means "about to be written", which is open by definition. A stored row
  // must actually be pending: `failed` needs a human either way, and `done` or
  // `superseded` are settled.
  if (subject.status && subject.status !== ProductResolutionStatus.pending) {
    return 'not_open';
  }

  if (isNil(subject.reviewTriggers)) return 'unclassified';
  if (!isEmpty(subject.reviewTriggers)) return 'triggered';

  if (
    isNil(subject.decisionConfidence) ||
    subject.decisionConfidence < config.minConfidence
  ) {
    return 'below_confidence';
  }

  if (isEmpty(subject.candidates)) return 'no_candidates';

  return undefined;
}

export function isDeterministicallyTrusted(
  subject: TrustRuleSubject,
  config: Pick<DeterministicAutomationConfig, 'minConfidence'>,
): boolean {
  return trustRuleRejection(subject, config) === undefined;
}

/** Config with the shipped defaults underneath, read in one place so the record-
 *  time and nightly paths cannot end up applying different thresholds. */
export function deterministicAutomationConfig(
  config: DynamicConfigService,
): DeterministicAutomationConfig {
  const automation = config.resolution?.automation;
  const deterministic = automation?.deterministic;
  const defaults = RESOLUTION_DEFAULTS.automation;

  return {
    // The master switch gates both paths, so turning automation off is one flag
    // rather than a checklist.
    enabled:
      (automation?.enabled ?? defaults.enabled) &&
      (deterministic?.enabled ?? defaults.deterministic.enabled),
    atRecordTime:
      deterministic?.atRecordTime ?? defaults.deterministic.atRecordTime,
    dryRun: deterministic?.dryRun ?? defaults.deterministic.dryRun,
    minConfidence:
      deterministic?.minConfidence ?? defaults.deterministic.minConfidence,
    maxPerRunNightly:
      deterministic?.maxPerRunNightly ??
      defaults.deterministic.maxPerRunNightly,
  };
}

/** Same shape for the AI path, and the same reason: the on-demand endpoint and
 *  the nightly batch must not be able to run under different settings. */
export function aiAutomationConfig(
  config: DynamicConfigService,
): AiAutomationConfig {
  const automation = config.resolution?.automation;
  const ai = automation?.ai;
  const defaults = RESOLUTION_DEFAULTS.automation;

  return {
    enabled: (automation?.enabled ?? defaults.enabled) && (ai?.enabled ?? defaults.ai.enabled),
    dryRun: ai?.dryRun ?? defaults.ai.dryRun,
    model: ai?.model ?? defaults.ai.model,
    effort: ai?.effort ?? defaults.ai.effort,
    executeActions: ai?.executeActions ?? defaults.ai.executeActions,
    executeDestructive:
      ai?.executeDestructive ?? defaults.ai.executeDestructive,
    maxPerRun: ai?.maxPerRun ?? defaults.ai.maxPerRun,
    minPriority: ai?.minPriority ?? defaults.ai.minPriority,
    maxCostUsdPerRun: ai?.maxCostUsdPerRun ?? defaults.ai.maxCostUsdPerRun,
    reReviewAfterDays: ai?.reReviewAfterDays ?? defaults.ai.reReviewAfterDays,
  };
}
