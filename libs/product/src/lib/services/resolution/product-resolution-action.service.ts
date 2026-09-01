import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ProductResolution,
  ProductResolutionDecisionEntry,
  ProductResolutionRepository,
  ProductResolutionStatus,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionCorrection,
  ResolutionDecidedBy,
  ResolutionVerdict,
  type AppendDecisionPatch,
  type ProductResolutionDecisionAction,
  type ProductResolutionState,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { isEmpty } from 'lodash';
import { ProductMergeService } from '../merge/product-merge.service';
import { ProductSplitService } from '../merge/product-split.service';
import { selectMergeTarget } from '../duplicate/select-merge-target';
import { ProductResolutionStateService } from './product-resolution-state.service';

/**
 * Who is performing this action.
 *
 * Required, never defaulted. A default of `admin` would be the more convenient
 * signature and exactly the wrong one: a new automated caller that forgot to
 * pass an actor would silently record itself as a human *and* stamp
 * `reviewedAt`, which permanently withdraws the row from every automated path.
 * That failure leaves no error behind, so the type system is the only place it
 * can be caught.
 */
export interface ResolutionActorParams {
  actor: ResolutionActor;
}

export interface AcceptResolutionParams extends ResolutionActorParams {
  note?: string;
}

export interface DeclineResolutionParams extends ResolutionActorParams {
  correction: ResolutionCorrection;
  /** Required when `correction` is `merge_into`. */
  targetProductId?: string;
  note?: string;
}

export interface ReopenResolutionParams extends ResolutionActorParams {
  note?: string;
}

/**
 * The single entry point for every review action on a `ProductResolution`, and
 * the only writer of its workflow state — controllers hold no state logic.
 *
 * Every action follows the same shape: load the row, re-derive what is legal
 * from **live database state** (not the stored snapshot), validate the request
 * against that, perform the catalog effect by delegating to the merge/split
 * services, then append exactly one decision-log entry describing what was
 * decided and whether it was carried out.
 *
 * A failed catalog effect is recorded rather than swallowed: the entry keeps the
 * error, the row moves to `failed`, and it stays visible for `retry`.
 */
@Injectable()
export class ProductResolutionActionService {
  private readonly logger = new CustomLogger(
    ProductResolutionActionService.name,
  );

  constructor(
    private readonly resolutionRepo: ProductResolutionRepository,
    private readonly stateService: ProductResolutionStateService,
    private readonly mergeService: ProductMergeService,
    private readonly splitService: ProductSplitService,
  ) {}

  /**
   * "The system got this right." Performs the machine's action only if it was
   * never carried out — a scrape-time resolution already matched or created its
   * product, whereas a duplicate pair is only a proposal until now. One rule,
   * both flows.
   */
  public async accept(
    id: string,
    params: AcceptResolutionParams,
  ): Promise<ProductResolution> {
    const { resolution, state } = await this.loadAndDerive(id);
    this.assertAvailable(state, 'accept');

    if (state.lastPerformed) {
      return this.commit(resolution, {
        actor: params.actor,
        verdict: ResolutionVerdict.accept,
        action: { kind: ResolutionActionKind.none },
        actionPerformed: false,
        note: params.note,
        patch: { status: ProductResolutionStatus.done, accepted: true },
      });
    }

    return this.performMergeProposal(resolution, params.actor, params.note);
  }

  /**
   * "The current state is wrong." Which correction is legal comes from the last
   * performed action, so declining twice keeps reversing whatever is actually in
   * effect rather than re-litigating the original verdict.
   */
  public async decline(
    id: string,
    params: DeclineResolutionParams,
  ): Promise<ProductResolution> {
    const { resolution, state } = await this.loadAndDerive(id);
    this.assertAvailable(state, 'decline', params.correction);

    switch (params.correction) {
      case ResolutionCorrection.split:
        return this.performSplit(resolution, state, params.actor, params.note);
      case ResolutionCorrection.merge_into:
        return this.performMergeInto(resolution, state, params);
      case ResolutionCorrection.dismiss:
      default:
        return this.commit(resolution, {
          actor: params.actor,
          verdict: ResolutionVerdict.decline,
          action: { kind: ResolutionActionKind.none },
          actionPerformed: false,
          note: params.note,
          patch: { status: ProductResolutionStatus.done, accepted: false },
        });
    }
  }

  /** Puts a decided row back in the queue. Never undoes catalog effects — the
   *  reopened row simply offers the correction that reverses current state. */
  public async reopen(
    id: string,
    params: ReopenResolutionParams,
  ): Promise<ProductResolution> {
    const { resolution, state } = await this.loadAndDerive(id);
    this.assertAvailable(state, 'reopen');

    return this.commit(resolution, {
      actor: params.actor,
      verdict: ResolutionVerdict.reopen,
      action: { kind: ResolutionActionKind.none },
      actionPerformed: false,
      note: params.note,
      patch: { status: ProductResolutionStatus.pending, accepted: false },
    });
  }

  /** Re-runs the action that failed, against freshly derived state — the world
   *  may have changed since, which is exactly why it is re-derived. */
  public async retry(
    id: string,
    params: ResolutionActorParams,
  ): Promise<ProductResolution> {
    const { resolution, state } = await this.loadAndDerive(id);
    this.assertAvailable(state, 'retry');

    const failed = this.findLastFailed(resolution);
    if (!failed) {
      throw new BadRequestException('No failed action to retry');
    }

    switch (failed.action.kind) {
      case ResolutionActionKind.merge:
        return failed.verdict === ResolutionVerdict.accept
          ? this.performMergeProposal(resolution, params.actor, failed.note)
          : this.performMergeInto(resolution, state, {
              actor: params.actor,
              correction: ResolutionCorrection.merge_into,
              targetProductId: failed.action.targetProductId,
              note: failed.note,
            });
      case ResolutionActionKind.split:
        return this.performSplit(resolution, state, params.actor, failed.note);
      default:
        throw new BadRequestException(
          `Cannot retry action "${failed.action.kind}"`,
        );
    }
  }

  private async loadAndDerive(
    id: string,
  ): Promise<{ resolution: ProductResolution; state: ProductResolutionState }> {
    const resolution = await this.resolutionRepo.findForAction(id);
    if (!resolution) {
      throw new NotFoundException(`Resolution ${id} not found`);
    }
    return {
      resolution,
      state: await this.stateService.deriveVerified(resolution),
    };
  }

  private assertAvailable(
    state: ProductResolutionState,
    action: 'accept' | 'decline' | 'reopen' | 'retry',
    correction?: ResolutionCorrection,
  ): void {
    const allowed = state.availableActions.some(
      (available) =>
        available.action === action &&
        (correction === undefined || available.correction === correction),
    );

    if (!allowed) {
      const what = correction ? `${action} (${correction})` : action;
      const why = isEmpty(state.blockedReasons)
        ? `status is "${state.status}"`
        : state.blockedReasons.join(', ');
      throw new BadRequestException(`Cannot ${what} this resolution: ${why}`);
    }
  }

  /** Accept on a not-yet-executed duplicate proposal: carry out the merge the
   *  system proposed, oldest product winning. */
  private async performMergeProposal(
    resolution: ProductResolution,
    actor: ResolutionActor,
    note?: string,
  ): Promise<ProductResolution> {
    if (!resolution.productA || !resolution.productB) {
      // Nothing to execute and nothing already executed — a judgment-only row.
      return this.commit(resolution, {
        actor,
        verdict: ResolutionVerdict.accept,
        action: { kind: ResolutionActionKind.none },
        actionPerformed: false,
        note,
        patch: { status: ProductResolutionStatus.done, accepted: true },
      });
    }

    const { sourceId, targetId } = selectMergeTarget(
      resolution.productA,
      resolution.productB,
    );

    return this.runAction(resolution, {
      actor,
      verdict: ResolutionVerdict.accept,
      accepted: true,
      note,
      buildAction: (movedSourceRecordIds) => ({
        kind: ResolutionActionKind.merge,
        productId: targetId,
        sourceProductId: sourceId,
        targetProductId: targetId,
        sourceRecordIds: movedSourceRecordIds,
      }),
      perform: async () => {
        const { movedSourceRecordIds } = await this.mergeService.mergeProducts({
          sourceId,
          targetId,
        });
        return { movedSourceRecordIds, mergedAt: new Date() };
      },
    });
  }

  /** Decline → the resolution attached this listing to the wrong product (or a
   *  merge was wrong): carve the listings out into their own product. */
  private async performSplit(
    resolution: ProductResolution,
    state: ProductResolutionState,
    actor: ResolutionActor,
    note?: string,
  ): Promise<ProductResolution> {
    const sourceRecordIds = state.splittableSourceRecordIds;
    const originProductId = state.listingProductId;

    return this.runAction(resolution, {
      actor,
      verdict: ResolutionVerdict.decline,
      accepted: false,
      note,
      buildAction: (_moved, newProductId) => ({
        kind: ResolutionActionKind.split,
        productId: newProductId,
        sourceProductId: originProductId,
        sourceRecordIds,
      }),
      perform: async () => {
        const product = await this.splitService.splitIntoNewProduct({
          sourceRecordIds,
          reason: `resolution ${resolution.id} declined`,
        });
        return { newProductId: product.id, resolvedProductId: product.id };
      },
    });
  }

  /** Decline → this listing should never have had its own product: fold it into
   *  the one the admin picked. */
  private async performMergeInto(
    resolution: ProductResolution,
    state: ProductResolutionState,
    params: DeclineResolutionParams,
  ): Promise<ProductResolution> {
    const sourceId = state.listingProductId;
    const targetId = params.targetProductId;

    if (!targetId) {
      throw new BadRequestException('targetProductId is required to merge');
    }
    if (!sourceId) {
      throw new BadRequestException(
        'Cannot merge: this resolution has no product to merge from',
      );
    }
    if (sourceId === targetId) {
      throw new BadRequestException(
        'Cannot merge a product into itself — pick a different target',
      );
    }

    return this.runAction(resolution, {
      actor: params.actor,
      verdict: ResolutionVerdict.decline,
      accepted: false,
      note: params.note,
      buildAction: (movedSourceRecordIds) => ({
        kind: ResolutionActionKind.merge,
        productId: targetId,
        sourceProductId: sourceId,
        targetProductId: targetId,
        sourceRecordIds: movedSourceRecordIds,
      }),
      perform: async () => {
        const { movedSourceRecordIds } = await this.mergeService.mergeProducts({
          sourceId,
          targetId,
        });
        return {
          movedSourceRecordIds,
          mergedAt: new Date(),
          resolvedProductId: targetId,
        };
      },
    });
  }

  /**
   * Runs a catalog-mutating action and records the outcome either way. Success
   * and failure both produce exactly one log entry — the difference is
   * `actionPerformed` and the resulting status, so a failed action is visible
   * and retryable instead of being lost.
   */
  private async runAction(
    resolution: ProductResolution,
    spec: {
      actor: ResolutionActor;
      verdict: ResolutionVerdict;
      accepted: boolean;
      note?: string;
      buildAction: (
        movedSourceRecordIds?: string[],
        newProductId?: string,
      ) => ProductResolutionDecisionAction;
      perform: () => Promise<{
        movedSourceRecordIds?: string[];
        newProductId?: string;
        mergedAt?: Date;
        resolvedProductId?: string;
      }>;
    },
  ): Promise<ProductResolution> {
    try {
      const outcome = await spec.perform();

      return await this.commit(resolution, {
        actor: spec.actor,
        verdict: spec.verdict,
        action: spec.buildAction(
          outcome.movedSourceRecordIds,
          outcome.newProductId,
        ),
        actionPerformed: true,
        note: spec.note,
        patch: {
          status: ProductResolutionStatus.done,
          accepted: spec.accepted,
          mergedAt: outcome.mergedAt,
          resolvedProductId: outcome.resolvedProductId,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Resolution action failed', {
        resolutionId: resolution.id,
        verdict: spec.verdict,
        error: message,
      });

      await this.commit(resolution, {
        actor: spec.actor,
        verdict: spec.verdict,
        action: spec.buildAction(),
        actionPerformed: false,
        note: spec.note,
        error: message,
        patch: { status: ProductResolutionStatus.failed, accepted: false },
      });

      throw error;
    }
  }

  /**
   * One log entry plus the workflow fields that go with it — the only place any
   * of them is written.
   *
   * Two of those fields are derived from the actor rather than passed in, and
   * both derivations are the point of the actor existing:
   *
   * - **`reviewedAt` only for `admin`.** It no longer means "reviewed" in the
   *   loose sense; it means *a human touched this row*, and it is what both
   *   automated paths test to know they must keep away. If automation wrote it,
   *   the machine would lock rows away from itself and a reopened row could
   *   never come back under automation.
   * - **`decidedBy` tracks who settled it**, set when the row goes `done` and
   *   cleared when a reopen puts it back in the queue. A `failed` row is neither
   *   settled nor reopened, so it keeps whatever it had — the action that failed
   *   did not decide anything.
   */
  private async commit(
    resolution: ProductResolution,
    params: {
      actor: ResolutionActor;
      verdict: ResolutionVerdict;
      action: ProductResolutionDecisionAction;
      actionPerformed: boolean;
      note?: string;
      error?: string;
      patch: AppendDecisionPatch;
    },
  ): Promise<ProductResolution> {
    const now = new Date();
    const entry: ProductResolutionDecisionEntry = {
      at: now.toISOString(),
      actor: params.actor,
      verdict: params.verdict,
      action: params.action,
      actionPerformed: params.actionPerformed,
      performedAt: params.actionPerformed ? now.toISOString() : undefined,
      error: params.error,
      note: params.note,
    };

    await this.resolutionRepo.appendDecision(resolution.id, entry, {
      ...params.patch,
      reviewedAt:
        params.actor === ResolutionActor.admin ? now : undefined,
      reviewNote: params.note ?? resolution.reviewNote,
      decidedBy: decidedByFor(params.actor, params.patch.status),
    });

    return this.resolutionRepo.findByIdOrFail(resolution.id);
  }

  private findLastFailed(
    resolution: ProductResolution,
  ): ProductResolutionDecisionEntry | undefined {
    return [...(resolution.decisions ?? [])]
      .reverse()
      .find((entry) => !entry.actionPerformed && !!entry.error);
  }
}

/**
 * Who currently owns the verdict on a row.
 *
 * `null` on a reopen is a real clear, not a no-op: a row back in the queue has
 * no decider again, and leaving the old value would keep it showing in the
 * automation audit as something the machine had closed.
 *
 * Returns `undefined` — leave the column alone — for any other status, so a
 * failed action does not claim to have decided anything.
 */
function decidedByFor(
  actor: ResolutionActor,
  status?: ProductResolutionStatus,
): ResolutionDecidedBy | null | undefined {
  if (status === ProductResolutionStatus.pending) return null;
  if (status !== ProductResolutionStatus.done) return undefined;

  switch (actor) {
    case ResolutionActor.system:
      return ResolutionDecidedBy.system;
    case ResolutionActor.ai:
      return ResolutionDecidedBy.ai;
    case ResolutionActor.admin:
    default:
      return ResolutionDecidedBy.admin;
  }
}
