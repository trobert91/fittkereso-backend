/**
 * Who made a decision.
 *
 * `system` covers both the producing pipeline's own seed entry and the
 * deterministic trust rule that can settle a row without asking anyone; `ai` is
 * the LLM reviewer. The distinction that matters operationally is not
 * machine-vs-human but **whether `reviewedAt` gets written**: only `admin` does,
 * and that is what withdraws a row from every automated path for good.
 */
export enum ResolutionActor {
  system = 'system',
  ai = 'ai',
  admin = 'admin',
}

/** What was decided. The first three are the producing system's own verdicts
 *  (written at record time); the rest are human review actions. */
export enum ResolutionVerdict {
  /** System resolved the input to an existing product. */
  matched_existing = 'matched_existing',
  /** System found no match; a new product was created for the listing. */
  created_new = 'created_new',
  /** System flagged two products as duplicates. Nothing done to the catalog. */
  duplicate_proposed = 'duplicate_proposed',
  accept = 'accept',
  decline = 'decline',
  reopen = 'reopen',
}

/** The catalog effect a decision implies. `none` means the decision is pure
 *  judgment (a dismissal, or a re-open) with nothing to carry out. */
export enum ResolutionActionKind {
  match = 'match',
  create = 'create',
  merge = 'merge',
  split = 'split',
  none = 'none',
}

export interface ProductResolutionDecisionAction {
  kind: ResolutionActionKind;
  /** The product the listing(s) ended up on after this action. */
  productId?: string;
  /** `merge`: the product that was merged away. `split`: the product the
   *  listings were carved out of. */
  sourceProductId?: string;
  targetProductId?: string;
  /** The listings this action moved. For `merge` this is the entire reversal
   *  mechanism — splitting these back out re-creates the merged-away product
   *  from live source data, so no snapshot is needed. Always re-validated
   *  against the database before being acted on, since a record may have been
   *  deleted or moved again since. */
  sourceRecordIds?: string[];
}

/**
 * One entry in a `ProductResolution`'s append-only decision log. Index 0 is
 * always the producing system's own decision, so the log reads as a single
 * story: what the system concluded and whether it acted on it, then what each
 * human concluded and whether that was acted on.
 *
 * `actionPerformed` is what makes the two intake flows uniform rather than
 * special-cased: a scrape-time resolution was already executed when it was
 * recorded (the product was matched or created), while a duplicate pair is a
 * proposal with nothing done yet. Accept therefore needs one rule — perform the
 * action if it hasn't been performed, otherwise just confirm.
 */
export interface ProductResolutionDecisionEntry {
  /** ISO timestamp. */
  at: string;
  actor: ResolutionActor;
  verdict: ResolutionVerdict;
  action: ProductResolutionDecisionAction;
  actionPerformed: boolean;
  /** ISO timestamp; set when `actionPerformed` is true. */
  performedAt?: string;
  /** Set when an attempted action threw — the row goes to `failed` and keeps
   *  this for the admin to see before retrying. */
  error?: string;
  /** Free-text note from the admin who made this decision. */
  note?: string;
}
