/**
 * Why a row might be wrong.
 *
 * Not a severity scale and never an ordering term — `priority` alone orders the
 * queue. Each name earns its place by doing at least one of three jobs: blocking
 * deterministic auto-accept, routing the AI prompt ("look for this"), or giving a
 * human a filter chip worth clicking.
 *
 * The empty list is the load-bearing value: `reviewTriggers = '[]'` is what
 * auto-accept trusts. It means *"no known suspicion pattern"*, not *"verified
 * correct"* — a lookalike name plus a polluted alias can clear it with nothing
 * firing. That is acceptable only because auto-accept is non-destructive and
 * reversible, and `decidedBy` makes every automated close auditable.
 *
 * `NULL` is not the same as `[]`: it means the row has never been classified, and
 * an unclassified row is ineligible for every automated path.
 */
export enum ResolutionReviewTrigger {
  /** Asserted sameness while the specs disagree. The one trigger that reads a
   *  direct contradiction rather than a weak signal. */
  spec_conflict = 'spec_conflict',
  /** The winner barely beat the runner-up. Worth blocking on because `margin`
   *  carries only .085 of the confidence weight — a two-point gap costs about
   *  three points of confidence, so a coin-flip can still clear 90. */
  narrow_margin = 'narrow_margin',
  /** The match rests on the name alone: no comparable specs and no alias
   *  corroboration. Not an auto-accept blocker — confidence already excludes
   *  these on its own — but the AI and a human both want to see them. */
  name_only_match = 'name_only_match',
  /** A candidate scored well enough to accept and was stopped by a gate.
   *  Confidence is structurally weakest here, because the gate outcome and the
   *  score it was derived from move together. */
  gate_only_rejection = 'gate_only_rejection',
  /** The best candidate fell just short of the accept threshold.
   *  Best-vs-threshold, distinct from `narrow_margin`'s best-vs-second. */
  near_miss_rejection = 'near_miss_rejection',
  /** Recall found nothing for a listing that named a brand and a model, *and*
   *  the catalog does hold products of that brand and category — so finding
   *  nothing is genuinely surprising. Typically a brand-alias gap or an
   *  over-tight filter. Without the catalog check this fires on every ordinary
   *  new product and means nothing. */
  no_candidates_but_named = 'no_candidates_but_named',
  /** Nothing was recalled and the input named no brand or model. Unjudgeable
   *  from stored data by anyone, so it blocks the AI as well as auto-accept —
   *  spending tokens here buys nothing. */
  insufficient_evidence = 'insufficient_evidence',
}

/** The AI reviewer's own confidence in its verdict. Coarse on purpose: three
 *  buckets are what the execution rule needs, and a 0–100 self-report would
 *  invite false precision from a number the model is not calibrated to give. */
export enum ResolutionAiConfidence {
  low = 'low',
  medium = 'medium',
  high = 'high',
}

/** Whether the AI agreed with what the producing system concluded. `abstain` is
 *  a real outcome, not a failure — it is treated as `low` confidence, which
 *  keeps the row pending with the reasoning attached. */
export enum ResolutionAiVerdict {
  agree = 'agree',
  disagree = 'disagree',
  abstain = 'abstain',
}

/**
 * Who settled the row.
 *
 * The automation audit stream: "what did the machine close last night" is
 * `decidedBy IN (system, ai) AND status = done`, which is why no separate
 * spot-check mechanism is needed. Cleared on reopen, because a reopened row has
 * no decider again.
 *
 * Deliberately separate from `ResolutionActor` on a decision-log entry: the log
 * records *every* actor who ever touched the row, while this records only the one
 * whose decision currently stands.
 */
export enum ResolutionDecidedBy {
  system = 'system',
  ai = 'ai',
  admin = 'admin',
}

/** What the AI reviewer recommended. Deliberately the same vocabulary
 *  `ProductResolutionStateService` already derives as `availableActions`, so a
 *  recommendation is directly executable through `ProductResolutionActionService`
 *  rather than needing a translation layer that could disagree with it. */
export enum ResolutionAiRecommendedAction {
  accept = 'accept',
  dismiss = 'dismiss',
  split = 'split',
  merge_into = 'merge_into',
}

/** The stored result of one AI review pass. Cleared whenever the row's evidence
 *  is refreshed, so a stale verdict is never displayed beside fresh evidence. */
export interface ProductResolutionAiReview {
  verdict: ResolutionAiVerdict;
  recommendedAction: ResolutionAiRecommendedAction;
  /** Required when `recommendedAction` is `merge_into`. Resolved back to a real
   *  product id from the short `c1..cN` label the model was shown. */
  targetProductId?: string;
  reasoning: string;
  /** Which fields the model says it based the verdict on. Read as a prompt
   *  quality signal, not as proof — but a verdict citing nothing is a verdict to
   *  distrust. */
  evidenceCited: string[];
  model: string;
  costUsd?: number;
  /** Whether the recommendation was actually carried out. False for every
   *  advisory verdict, and for a high-confidence one blocked by the
   *  destructive-action kill switch. */
  executed: boolean;
  error?: string;
}
