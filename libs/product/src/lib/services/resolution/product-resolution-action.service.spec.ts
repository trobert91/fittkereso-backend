import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ProductResolutionStatus,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionCorrection,
  ResolutionVerdict,
} from '@fittkereso-backend/database';
import type {
  ProductResolution,
  ProductResolutionRepository,
  ProductResolutionState,
} from '@fittkereso-backend/database';
import { ProductResolutionActionService } from './product-resolution-action.service';
import type { ProductResolutionStateService } from './product-resolution-state.service';
import type { ProductMergeService } from '../merge/product-merge.service';
import type { ProductSplitService } from '../merge/product-split.service';

function makeState(
  overrides: Partial<ProductResolutionState> = {},
): ProductResolutionState {
  return {
    status: ProductResolutionStatus.pending,
    accepted: false,
    splittableSourceRecordIds: ['record-1'],
    availableActions: [],
    blockedReasons: [],
    ...overrides,
  };
}

describe('ProductResolutionActionService', () => {
  let service: ProductResolutionActionService;
  let repo: {
    findForAction: jest.Mock;
    appendDecision: jest.Mock;
    findByIdOrFail: jest.Mock;
  };
  let stateService: { deriveVerified: jest.Mock };
  let mergeService: { mergeProducts: jest.Mock };
  let splitService: { splitIntoNewProduct: jest.Mock };

  const resolution = {
    id: 'resolution-1',
    productA: { id: 'product-a', createdAt: new Date('2024-01-01') },
    productB: { id: 'product-b', createdAt: new Date('2024-06-01') },
    decisions: [],
  } as unknown as ProductResolution;

  beforeEach(() => {
    repo = {
      findForAction: jest.fn().mockResolvedValue(resolution),
      appendDecision: jest.fn().mockResolvedValue(undefined),
      findByIdOrFail: jest.fn().mockResolvedValue(resolution),
    };
    stateService = { deriveVerified: jest.fn() };
    mergeService = {
      mergeProducts: jest.fn().mockResolvedValue({
        product: { id: 'product-a' },
        movedSourceRecordIds: ['record-7', 'record-8'],
      }),
    };
    splitService = {
      splitIntoNewProduct: jest.fn().mockResolvedValue({ id: 'product-new' }),
    };

    service = new ProductResolutionActionService(
      repo as unknown as ProductResolutionRepository,
      stateService as unknown as ProductResolutionStateService,
      mergeService as unknown as ProductMergeService,
      splitService as unknown as ProductSplitService,
    );
  });

  function lastEntry() {
    return repo.appendDecision.mock.calls[0][1];
  }

  function lastPatch() {
    return repo.appendDecision.mock.calls[0][2];
  }

  describe('accept', () => {
    it('is confirmation-only when the system already carried its decision out', async () => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          availableActions: [{ action: 'accept', requiresTargetProduct: false }],
          lastPerformed: {
            at: '',
            actor: ResolutionActor.system,
            verdict: ResolutionVerdict.matched_existing,
            action: { kind: ResolutionActionKind.match },
            actionPerformed: true,
          },
        }),
      );

      await service.accept('resolution-1', {});

      expect(mergeService.mergeProducts).not.toHaveBeenCalled();
      expect(lastEntry().actionPerformed).toBe(false);
      expect(lastPatch()).toMatchObject({
        status: ProductResolutionStatus.done,
        accepted: true,
      });
    });

    // A duplicate pair is only a proposal until a human accepts it — this is
    // where the merge actually happens.
    it('executes the proposed merge when nothing has been performed yet', async () => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          availableActions: [{ action: 'accept', requiresTargetProduct: false }],
        }),
      );

      await service.accept('resolution-1', {});

      // Oldest product wins: productA (Jan) survives, productB (Jun) is merged away.
      expect(mergeService.mergeProducts).toHaveBeenCalledWith({
        sourceId: 'product-b',
        targetId: 'product-a',
      });
      expect(lastEntry()).toMatchObject({
        actor: ResolutionActor.admin,
        verdict: ResolutionVerdict.accept,
        actionPerformed: true,
      });
    });

    it('records which listings the merge moved, so the merge stays reversible', async () => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          availableActions: [{ action: 'accept', requiresTargetProduct: false }],
        }),
      );

      await service.accept('resolution-1', {});

      expect(lastEntry().action.sourceRecordIds).toEqual([
        'record-7',
        'record-8',
      ]);
    });

    it('rejects an accept the derived state does not allow', async () => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({ status: ProductResolutionStatus.done, availableActions: [] }),
      );

      await expect(service.accept('resolution-1', {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mergeService.mergeProducts).not.toHaveBeenCalled();
    });
  });

  describe('decline', () => {
    it('splits the listings the state says are splittable', async () => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          splittableSourceRecordIds: ['record-7', 'record-8'],
          availableActions: [
            {
              action: 'decline',
              correction: ResolutionCorrection.split,
              requiresTargetProduct: false,
            },
          ],
        }),
      );

      await service.decline('resolution-1', {
        correction: ResolutionCorrection.split,
      });

      expect(splitService.splitIntoNewProduct).toHaveBeenCalledWith(
        expect.objectContaining({ sourceRecordIds: ['record-7', 'record-8'] }),
      );
      expect(lastEntry().action.kind).toBe(ResolutionActionKind.split);
      expect(lastPatch()).toMatchObject({
        status: ProductResolutionStatus.done,
        accepted: false,
      });
    });

    it('merges the listing product into the picked target', async () => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          listingProductId: 'product-x',
          availableActions: [
            {
              action: 'decline',
              correction: ResolutionCorrection.merge_into,
              requiresTargetProduct: true,
            },
          ],
        }),
      );

      await service.decline('resolution-1', {
        correction: ResolutionCorrection.merge_into,
        targetProductId: 'product-y',
      });

      expect(mergeService.mergeProducts).toHaveBeenCalledWith({
        sourceId: 'product-x',
        targetId: 'product-y',
      });
    });

    it('refuses to merge a product into itself', async () => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          listingProductId: 'product-x',
          availableActions: [
            {
              action: 'decline',
              correction: ResolutionCorrection.merge_into,
              requiresTargetProduct: true,
            },
          ],
        }),
      );

      await expect(
        service.decline('resolution-1', {
          correction: ResolutionCorrection.merge_into,
          targetProductId: 'product-x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mergeService.mergeProducts).not.toHaveBeenCalled();
    });

    it('records a dismissal without touching the catalog', async () => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          availableActions: [
            {
              action: 'decline',
              correction: ResolutionCorrection.dismiss,
              requiresTargetProduct: false,
            },
          ],
        }),
      );

      await service.decline('resolution-1', {
        correction: ResolutionCorrection.dismiss,
        note: 'not the same bike',
      });

      expect(mergeService.mergeProducts).not.toHaveBeenCalled();
      expect(splitService.splitIntoNewProduct).not.toHaveBeenCalled();
      expect(lastEntry()).toMatchObject({
        action: { kind: ResolutionActionKind.none },
        actionPerformed: false,
        note: 'not the same bike',
      });
    });

    it('rejects a correction the current state cannot reverse', async () => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          blockedReasons: ['merge_already_reversed'],
          availableActions: [
            {
              action: 'decline',
              correction: ResolutionCorrection.dismiss,
              requiresTargetProduct: false,
            },
          ],
        }),
      );

      await expect(
        service.decline('resolution-1', {
          correction: ResolutionCorrection.split,
        }),
      ).rejects.toThrow(/merge_already_reversed/);
    });
  });

  describe('when the catalog action fails', () => {
    beforeEach(() => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          availableActions: [
            {
              action: 'decline',
              correction: ResolutionCorrection.split,
              requiresTargetProduct: false,
            },
          ],
        }),
      );
      splitService.splitIntoNewProduct.mockRejectedValue(
        new Error('source records span two products'),
      );
    });

    // The failure has to be visible and retryable — a swallowed error would
    // leave the reviewer thinking the correction succeeded.
    it('marks the row failed and keeps the error on the log entry', async () => {
      await expect(
        service.decline('resolution-1', {
          correction: ResolutionCorrection.split,
        }),
      ).rejects.toThrow('source records span two products');

      expect(lastEntry()).toMatchObject({
        actionPerformed: false,
        error: 'source records span two products',
      });
      expect(lastPatch()).toMatchObject({
        status: ProductResolutionStatus.failed,
      });
    });

    it('writes exactly one log entry', async () => {
      await expect(
        service.decline('resolution-1', {
          correction: ResolutionCorrection.split,
        }),
      ).rejects.toThrow();

      expect(repo.appendDecision).toHaveBeenCalledTimes(1);
    });
  });

  describe('reopen', () => {
    it('returns the row to the queue without undoing anything', async () => {
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          status: ProductResolutionStatus.done,
          accepted: true,
          availableActions: [{ action: 'reopen', requiresTargetProduct: false }],
        }),
      );

      await service.reopen('resolution-1', {});

      expect(mergeService.mergeProducts).not.toHaveBeenCalled();
      expect(splitService.splitIntoNewProduct).not.toHaveBeenCalled();
      expect(lastEntry().verdict).toBe(ResolutionVerdict.reopen);
      expect(lastPatch()).toMatchObject({
        status: ProductResolutionStatus.pending,
        accepted: false,
      });
    });
  });

  describe('retry', () => {
    it('re-runs the failed action against freshly derived state', async () => {
      repo.findForAction.mockResolvedValue({
        ...resolution,
        decisions: [
          {
            at: '',
            actor: ResolutionActor.admin,
            verdict: ResolutionVerdict.decline,
            action: { kind: ResolutionActionKind.split },
            actionPerformed: false,
            error: 'db timeout',
          },
        ],
      });
      stateService.deriveVerified.mockResolvedValue(
        makeState({
          status: ProductResolutionStatus.failed,
          availableActions: [{ action: 'retry', requiresTargetProduct: false }],
        }),
      );

      await service.retry('resolution-1');

      expect(splitService.splitIntoNewProduct).toHaveBeenCalledTimes(1);
    });
  });

  it('404s on an unknown resolution', async () => {
    repo.findForAction.mockResolvedValue(null);

    await expect(service.accept('nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
