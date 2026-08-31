import {
  ProductResolutionStatus,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionCorrection,
  ResolutionVerdict,
} from '@fittkereso-backend/database';
import type {
  ProductResolution,
  ProductResolutionDecisionEntry,
  ProductSourceRecord,
} from '@fittkereso-backend/database';
import type {
  ProductModelRepository,
  ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import { ProductResolutionStateService } from './product-resolution-state.service';

function entry(
  overrides: Partial<ProductResolutionDecisionEntry> & {
    action?: Partial<ProductResolutionDecisionEntry['action']>;
  } = {},
): ProductResolutionDecisionEntry {
  return {
    at: new Date().toISOString(),
    actor: ResolutionActor.system,
    verdict: ResolutionVerdict.matched_existing,
    actionPerformed: true,
    ...overrides,
    action: {
      kind: ResolutionActionKind.match,
      ...(overrides.action ?? {}),
    },
  } as ProductResolutionDecisionEntry;
}

function makeResolution(
  overrides: Partial<ProductResolution> = {},
): ProductResolution {
  return {
    id: 'resolution-1',
    status: ProductResolutionStatus.pending,
    accepted: false,
    decisions: [],
    sourceRecord: {
      id: 'record-1',
      model: { id: 'product-1' },
    } as ProductSourceRecord,
    ...overrides,
  } as ProductResolution;
}

describe('ProductResolutionStateService', () => {
  let service: ProductResolutionStateService;
  let sourceRecordRepo: { find: jest.Mock };
  let productRepo: { repo: { exists: jest.Mock } };

  beforeEach(() => {
    sourceRecordRepo = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: 'record-1', model: { id: 'product-1' } }]),
    };
    productRepo = { repo: { exists: jest.fn().mockResolvedValue(true) } };

    service = new ProductResolutionStateService(
      sourceRecordRepo as unknown as ProductSourceRecordRepository,
      productRepo as unknown as ProductModelRepository,
    );
  });

  function corrections(state: { availableActions: { correction?: string }[] }) {
    return state.availableActions
      .filter((action) => action.correction)
      .map((action) => action.correction);
  }

  describe('the reversal table — which correction undoes the current state', () => {
    it('offers a split when the listing was attached to an existing product', () => {
      const state = service.derive(
        makeResolution({
          decisions: [entry({ action: { kind: ResolutionActionKind.match } })],
        }),
      );

      expect(corrections(state)).toContain(ResolutionCorrection.split);
      expect(state.splittableSourceRecordIds).toEqual(['record-1']);
    });

    it('offers a merge when a product was created for the listing', () => {
      const state = service.derive(
        makeResolution({
          decisions: [
            entry({
              verdict: ResolutionVerdict.created_new,
              action: { kind: ResolutionActionKind.create },
            }),
          ],
        }),
      );

      expect(corrections(state)).toContain(ResolutionCorrection.merge_into);
      expect(
        state.availableActions.find(
          (action) => action.correction === ResolutionCorrection.merge_into,
        )?.requiresTargetProduct,
      ).toBe(true);
    });

    // The point of deriving from the last performed action rather than the
    // original verdict: after a split, the listing no longer sits where the
    // original decision put it.
    it('offers a merge back after a split, suggesting the product it came from', () => {
      const state = service.derive(
        makeResolution({
          status: ProductResolutionStatus.done,
          decisions: [
            entry({ action: { kind: ResolutionActionKind.match } }),
            entry({
              actor: ResolutionActor.admin,
              verdict: ResolutionVerdict.decline,
              action: {
                kind: ResolutionActionKind.split,
                sourceProductId: 'product-1',
                productId: 'product-2',
              },
            }),
          ],
        }),
      );

      expect(corrections(state)).toContain(ResolutionCorrection.merge_into);
      expect(
        state.availableActions.find(
          (action) => action.correction === ResolutionCorrection.merge_into,
        )?.suggestedTargetProductId,
      ).toBe('product-1');
    });

    it('reverses a merge by splitting exactly the listings that merge moved', () => {
      const state = service.derive(
        makeResolution({
          status: ProductResolutionStatus.done,
          accepted: true,
          decisions: [
            entry({
              verdict: ResolutionVerdict.duplicate_proposed,
              actionPerformed: false,
              action: { kind: ResolutionActionKind.merge },
            }),
            entry({
              actor: ResolutionActor.admin,
              verdict: ResolutionVerdict.accept,
              action: {
                kind: ResolutionActionKind.merge,
                targetProductId: 'product-1',
                sourceRecordIds: ['record-7', 'record-8'],
              },
            }),
          ],
        }),
      );

      expect(corrections(state)).toContain(ResolutionCorrection.split);
      expect(state.splittableSourceRecordIds).toEqual(['record-7', 'record-8']);
    });

    it('offers only a dismissal when nothing has been performed yet', () => {
      const state = service.derive(
        makeResolution({
          decisions: [
            entry({
              verdict: ResolutionVerdict.duplicate_proposed,
              actionPerformed: false,
              action: { kind: ResolutionActionKind.merge },
            }),
          ],
        }),
      );

      expect(corrections(state)).toEqual([ResolutionCorrection.dismiss]);
    });

    it('always allows a dismissal, so a reviewer can disagree without committing to a change', () => {
      const state = service.derive(makeResolution());
      expect(corrections(state)).toContain(ResolutionCorrection.dismiss);
    });
  });

  describe('lifecycle actions', () => {
    it.each([
      [ProductResolutionStatus.pending, 'accept'],
      [ProductResolutionStatus.done, 'reopen'],
      [ProductResolutionStatus.failed, 'retry'],
    ])('offers %s rows the %s action', (status, expected) => {
      const state = service.derive(makeResolution({ status }));
      expect(state.availableActions.map((a) => a.action)).toContain(expected);
    });

    it('offers nothing on a superseded row — a newer row owns the situation', () => {
      const state = service.derive(
        makeResolution({ status: ProductResolutionStatus.superseded }),
      );

      expect(state.availableActions).toEqual([]);
      expect(state.blockedReasons).toContain('superseded');
    });
  });

  describe('deriveVerified — live state wins over the stored snapshot', () => {
    it('reads the listing product from the record as it is now, not as it was recorded', async () => {
      sourceRecordRepo.find.mockResolvedValue([
        { id: 'record-1', model: { id: 'product-moved' } },
      ]);

      const state = await service.deriveVerified(
        makeResolution({
          decisions: [entry({ action: { kind: ResolutionActionKind.match } })],
        }),
      );

      expect(state.listingProductId).toBe('product-moved');
    });

    it('drops records that no longer exist', async () => {
      sourceRecordRepo.find.mockResolvedValue([]);

      const state = await service.deriveVerified(
        makeResolution({
          decisions: [entry({ action: { kind: ResolutionActionKind.match } })],
        }),
      );

      expect(state.splittableSourceRecordIds).toEqual([]);
      expect(corrections(state)).not.toContain(ResolutionCorrection.split);
    });

    it('refuses to reverse a merge whose listings were already split back out', async () => {
      sourceRecordRepo.find.mockResolvedValue([
        { id: 'record-7', model: { id: 'somewhere-else' } },
      ]);

      const state = await service.deriveVerified(
        makeResolution({
          status: ProductResolutionStatus.done,
          decisions: [
            entry({
              actor: ResolutionActor.admin,
              verdict: ResolutionVerdict.accept,
              action: {
                kind: ResolutionActionKind.merge,
                targetProductId: 'product-1',
                sourceRecordIds: ['record-7'],
              },
            }),
          ],
        }),
      );

      expect(state.splittableSourceRecordIds).toEqual([]);
      expect(state.blockedReasons).toContain('merge_already_reversed');
      expect(corrections(state)).not.toContain(ResolutionCorrection.split);
    });

    it('blocks a merge when the product the listing sat on is gone', async () => {
      productRepo.repo.exists.mockResolvedValue(false);

      const state = await service.deriveVerified(
        makeResolution({
          decisions: [
            entry({
              verdict: ResolutionVerdict.created_new,
              action: { kind: ResolutionActionKind.create },
            }),
          ],
        }),
      );

      expect(state.blockedReasons).toContain('listing_product_missing');
      expect(corrections(state)).not.toContain(ResolutionCorrection.merge_into);
    });

    it('reports a legacy row with no listing as unsplittable', async () => {
      sourceRecordRepo.find.mockResolvedValue([]);

      const state = await service.deriveVerified(
        makeResolution({
          sourceRecord: null,
          resolvedProduct: null,
          decisions: [entry({ action: { kind: ResolutionActionKind.match } })],
        }),
      );

      expect(state.blockedReasons).toContain('no_source_record');
      expect(corrections(state)).toEqual([ResolutionCorrection.dismiss]);
    });
  });
});
