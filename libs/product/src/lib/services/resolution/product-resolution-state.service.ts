import { Injectable } from '@nestjs/common';
import {
  ProductModelRepository,
  ProductResolution,
  ProductResolutionDecisionEntry,
  ProductResolutionState,
  ProductResolutionStatus,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ResolutionActionKind,
  ResolutionAvailableAction,
  ResolutionCorrection,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import { compact, isEmpty, last, uniq } from 'lodash';

/**
 * Answers one question: *what can be done to this row right now?*
 *
 * Used by the search endpoint (to render the queue), the detail endpoint, and
 * as the orchestrator's guard — one derivation, so the API, the UI, and the
 * enforcement can never disagree about which action is legal.
 *
 * The available correction is a pure function of the latest **performed**
 * decision, never of the machine's original verdict. That distinction matters as
 * soon as a row is decided twice: after a split the listing no longer sits where
 * the original decision put it, so the next decline must reverse the split, not
 * the original match.
 */
@Injectable()
export class ProductResolutionStateService {
  constructor(
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly productRepo: ProductModelRepository,
  ) {}

  /**
   * Pure derivation from the row and its already-loaded relations — no queries,
   * so the search endpoint can call it per row without an N+1.
   */
  public derive(resolution: ProductResolution): ProductResolutionState {
    const lastPerformed = this.findLastPerformed(resolution);
    const blockedReasons: string[] = [];

    const listingProductId =
      resolution.sourceRecord?.model?.id ?? resolution.resolvedProduct?.id;
    const splittableSourceRecordIds = this.deriveSplittableIds(
      resolution,
      lastPerformed,
    );

    return {
      status: resolution.status,
      accepted: resolution.accepted,
      lastPerformed,
      listingProductId,
      splittableSourceRecordIds,
      availableActions: this.deriveActions({
        resolution,
        lastPerformed,
        listingProductId,
        splittableSourceRecordIds,
        blockedReasons,
      }),
      blockedReasons,
    };
  }

  /**
   * `derive` plus live database checks on the affected products. Always used
   * before acting, because the stored log describes what was true when the
   * decision was made — an unrelated merge may have moved the listing since, or
   * a product may be gone. Anything that no longer holds is dropped from
   * `availableActions` with a reason rather than failing mid-action.
   */
  public async deriveVerified(
    resolution: ProductResolution,
  ): Promise<ProductResolutionState> {
    const lastPerformed = this.findLastPerformed(resolution);
    const blockedReasons: string[] = [];

    const candidateIds = this.deriveSplittableIds(resolution, lastPerformed);
    const liveRecords = await this.loadLiveRecords(candidateIds);

    // Where does the listing actually live now? Read it off the source record
    // rather than trusting resolvedProduct, which is a write-time snapshot.
    const ownRecordId = resolution.sourceRecord?.id;
    const listingProductId =
      (ownRecordId ? liveRecords.get(ownRecordId)?.model?.id : undefined) ??
      resolution.sourceRecord?.model?.id ??
      resolution.resolvedProduct?.id;

    // For a merge, only records still sitting on the merge target are still
    // "moved by that merge" — any that were split off again are not ours to
    // move a second time.
    const expectedProductId =
      lastPerformed?.action.kind === ResolutionActionKind.merge
        ? lastPerformed.action.targetProductId ?? lastPerformed.action.productId
        : listingProductId;

    const splittableSourceRecordIds = candidateIds.filter((id) => {
      const record = liveRecords.get(id);
      if (!record) return false;
      return !expectedProductId || record.model?.id === expectedProductId;
    });

    if (!isEmpty(candidateIds) && isEmpty(splittableSourceRecordIds)) {
      blockedReasons.push(
        lastPerformed?.action.kind === ResolutionActionKind.merge
          ? 'merge_already_reversed'
          : 'source_record_moved',
      );
    }

    if (listingProductId && !(await this.productExists(listingProductId))) {
      blockedReasons.push('listing_product_missing');
    }

    return {
      status: resolution.status,
      accepted: resolution.accepted,
      lastPerformed,
      listingProductId,
      splittableSourceRecordIds,
      availableActions: this.deriveActions({
        resolution,
        lastPerformed,
        listingProductId: blockedReasons.includes('listing_product_missing')
          ? undefined
          : listingProductId,
        splittableSourceRecordIds,
        blockedReasons,
      }),
      blockedReasons: uniq(blockedReasons),
    };
  }

  private findLastPerformed(
    resolution: ProductResolution,
  ): ProductResolutionDecisionEntry | undefined {
    return last(
      (resolution.decisions ?? []).filter((entry) => entry.actionPerformed),
    );
  }

  /** Which listings a split would move, before any liveness filtering. */
  private deriveSplittableIds(
    resolution: ProductResolution,
    lastPerformed?: ProductResolutionDecisionEntry,
  ): string[] {
    // A merge names every record it moved — those are what reverse it.
    if (
      lastPerformed?.action.kind === ResolutionActionKind.merge &&
      !isEmpty(lastPerformed.action.sourceRecordIds)
    ) {
      return uniq(lastPerformed.action.sourceRecordIds ?? []);
    }

    // Otherwise the row is about one listing: its own.
    return compact([resolution.sourceRecord?.id]);
  }

  private deriveActions(params: {
    resolution: ProductResolution;
    lastPerformed?: ProductResolutionDecisionEntry;
    listingProductId?: string;
    splittableSourceRecordIds: string[];
    blockedReasons: string[];
  }): ResolutionAvailableAction[] {
    const {
      resolution,
      lastPerformed,
      listingProductId,
      splittableSourceRecordIds,
      blockedReasons,
    } = params;

    if (resolution.status === ProductResolutionStatus.superseded) {
      blockedReasons.push('superseded');
      return [];
    }

    const actions: ResolutionAvailableAction[] = [];

    if (resolution.status === ProductResolutionStatus.pending) {
      actions.push({ action: 'accept', requiresTargetProduct: false });
    }
    if (resolution.status === ProductResolutionStatus.done) {
      actions.push({ action: 'reopen', requiresTargetProduct: false });
    }
    if (resolution.status === ProductResolutionStatus.failed) {
      actions.push({ action: 'retry', requiresTargetProduct: false });
    }

    // Dismiss is always available: an admin can always record "this was wrong"
    // without committing to a catalog change.
    const corrections: ResolutionAvailableAction[] = [
      {
        action: 'decline',
        correction: ResolutionCorrection.dismiss,
        requiresTargetProduct: false,
      },
    ];

    const correction = this.correctionFor(lastPerformed);

    if (correction === ResolutionCorrection.split) {
      if (isEmpty(splittableSourceRecordIds)) {
        if (!blockedReasons.length) blockedReasons.push('no_source_record');
      } else {
        corrections.push({
          action: 'decline',
          correction: ResolutionCorrection.split,
          requiresTargetProduct: false,
        });
      }
    }

    if (correction === ResolutionCorrection.merge_into) {
      if (!listingProductId) {
        blockedReasons.push('no_listing_product');
      } else {
        corrections.push({
          action: 'decline',
          correction: ResolutionCorrection.merge_into,
          requiresTargetProduct: true,
          // After a split, the obvious candidate is the product it came from.
          suggestedTargetProductId:
            lastPerformed?.action.kind === ResolutionActionKind.split
              ? lastPerformed.action.sourceProductId
              : undefined,
        });
      }
    }

    return resolution.status === ProductResolutionStatus.done ||
      resolution.status === ProductResolutionStatus.pending ||
      resolution.status === ProductResolutionStatus.failed
      ? [...actions, ...corrections]
      : actions;
  }

  /**
   * The reversal table: which correction undoes the state each performed action
   * left behind. Closed by construction — split and merge_into are inverses of
   * each other, and a merge is undone by splitting its recorded listings back
   * out — so a row can be corrected repeatedly without reaching a state the
   * pipeline can't express.
   */
  private correctionFor(
    lastPerformed?: ProductResolutionDecisionEntry,
  ): ResolutionCorrection {
    switch (lastPerformed?.action.kind) {
      // Listing was attached to a pre-existing product → carve it back out.
      case ResolutionActionKind.match:
        return ResolutionCorrection.split;
      // Listings sit on the merge target → split the moved ones back out.
      case ResolutionActionKind.merge:
        return ResolutionCorrection.split;
      // Listing is on a product created for it, or just carved out → fold it
      // into the right product instead.
      case ResolutionActionKind.create:
      case ResolutionActionKind.split:
        return ResolutionCorrection.merge_into;
      default:
        return ResolutionCorrection.dismiss;
    }
  }

  private async loadLiveRecords(
    ids: string[],
  ): Promise<Map<string, ProductSourceRecord>> {
    if (isEmpty(ids)) {
      return new Map();
    }

    const records = await this.sourceRecordRepo.find({
      where: ids.map((id) => ({ id })),
      relations: [nameOf<ProductSourceRecord>('model')],
    });

    return new Map(records.map((record) => [record.id, record]));
  }

  private async productExists(id: string): Promise<boolean> {
    return this.productRepo.repo.exists({ where: { id } });
  }
}
