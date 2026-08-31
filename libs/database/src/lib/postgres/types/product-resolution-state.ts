import type { ProductResolutionDecisionEntry } from './product-resolution-decision-entry';
import type { ProductResolutionStatus } from './product-resolution-status';

/** What a decline can do to reverse whatever is currently in effect. */
export enum ResolutionCorrection {
  /** Carve the listing(s) out into a brand-new product. Also how a merge is
   *  reversed — the merge recorded which listings it moved. */
  split = 'split',
  /** Fold this product into an admin-picked target. */
  merge_into = 'merge_into',
  /** Record the disagreement without touching the catalog. */
  dismiss = 'dismiss',
}

export type ResolutionActionName = 'accept' | 'decline' | 'reopen' | 'retry';

export interface ResolutionAvailableAction {
  action: ResolutionActionName;
  /** Only set for `decline`. */
  correction?: ResolutionCorrection;
  requiresTargetProduct: boolean;
  /** A sensible default for the target picker — e.g. the product these listings
   *  were split out of. */
  suggestedTargetProductId?: string;
}

/**
 * The derived answer to "what can be done to this row right now?", computed
 * from the decision log plus live catalog state.
 *
 * Declared here, alongside the entity's own types, so the search layer can carry
 * it in its response and the product layer can compute it without either
 * depending on the other.
 */
export interface ProductResolutionState {
  status: ProductResolutionStatus;
  accepted: boolean;
  /** The most recent decision that actually changed the catalog. Every offered
   *  correction is derived from this, never from the original verdict. */
  lastPerformed?: ProductResolutionDecisionEntry;
  /** Which product the reviewed listing sits on right now. */
  listingProductId?: string;
  /** The listings a `split` would carve out, already filtered to ones that still
   *  exist and still sit where the log says they should. */
  splittableSourceRecordIds: string[];
  availableActions: ResolutionAvailableAction[];
  /** Machine-readable reasons an otherwise-expected action isn't offered. */
  blockedReasons: string[];
}
