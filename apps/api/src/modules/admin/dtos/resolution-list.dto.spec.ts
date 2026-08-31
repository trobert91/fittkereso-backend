import 'reflect-metadata';
import {
  ProductModel,
  ProductResolution,
  ProductResolutionFlow,
  ProductResolutionStatus,
  ProductSourceRecord,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionCorrection,
  ResolutionVerdict,
} from '@fittkereso-backend/database';
import type { ProductResolutionState } from '@fittkereso-backend/database';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { instanceToPlain } from 'class-transformer';
import { ResolutionListItem, ResolutionListResult } from './resolution-list.dto';

/**
 * The API serializes with `strategy: 'excludeAll'` (see `apps/api/src/app.ts`).
 * Under that strategy class-transformer only emits keys carrying `@Expose`
 * metadata on a *known target type*, so a response built from plain object
 * literals is silently reduced to `{}`. These tests run the real interceptor
 * options over the real DTOs, which is the only place that regression is
 * visible — controller unit tests never touch the interceptor.
 */
describe('resolution list serialization', () => {
  /** The groups `POST /admin-product/resolutions/search` serializes with. */
  const listOptions = {
    strategy: 'excludeAll' as const,
    groups: [SerializeGroup.adminList, SerializeGroup.list],
  };

  const makeProduct = (id: string, displayName: string): ProductModel => {
    const product = new ProductModel();
    product.id = id;
    product.displayName = displayName;
    return product;
  };

  const makeResolution = (): ProductResolution => {
    const resolution = new ProductResolution();
    resolution.id = 'resolution-1';
    resolution.flow = ProductResolutionFlow.product_resolution;
    resolution.status = ProductResolutionStatus.pending;
    resolution.accepted = false;
    resolution.similarityScore = 88;
    resolution.decisionConfidence = 82;
    resolution.anchorKey = 'source-1:sku-9';
    resolution.resolvedProduct = makeProduct('product-1', 'Sony WH-1000XM5');
    resolution.candidates = [
      {
        candidateId: 'product-1',
        displayName: 'Sony WH-1000XM5',
        source: 'fuzzy',
        matchScore: 88,
        gates: { passed: true, failedGates: [] },
      },
    ] as never;
    resolution.decisions = [
      {
        at: '2026-08-30T10:00:00.000Z',
        actor: ResolutionActor.system,
        verdict: ResolutionVerdict.matched_existing,
        action: { kind: ResolutionActionKind.match, productId: 'product-1' },
        actionPerformed: true,
      },
    ];

    const sourceRecord = new ProductSourceRecord();
    sourceRecord.id = 'record-1';
    sourceRecord.url = 'https://example.test/listing/9';
    sourceRecord.model = makeProduct('product-1', 'Sony WH-1000XM5');
    resolution.sourceRecord = sourceRecord;

    return resolution;
  };

  const makeState = (): ProductResolutionState => ({
    status: ProductResolutionStatus.pending,
    accepted: false,
    listingProductId: 'product-1',
    splittableSourceRecordIds: ['record-1'],
    availableActions: [
      { action: 'accept', requiresTargetProduct: false },
      {
        action: 'decline',
        correction: ResolutionCorrection.split,
        requiresTargetProduct: false,
      },
    ],
    blockedReasons: [],
  });

  it('emits a populated page rather than an empty object', () => {
    const page = new ResolutionListResult();
    page.items = [ResolutionListItem.of(makeResolution(), makeState())];
    page.page = 1;
    page.pageSize = 50;
    page.totalItems = 1;
    page.totalPages = 1;

    const plain = instanceToPlain(page, listOptions) as Record<string, any>;

    expect(plain.totalItems).toBe(1);
    expect(plain.items).toHaveLength(1);
    expect(plain.items[0].resolution.id).toBe('resolution-1');
  });

  it('carries the evidence the queue renders — candidates, log, score', () => {
    const item = ResolutionListItem.of(makeResolution(), makeState());

    const plain = instanceToPlain(item, listOptions) as Record<string, any>;

    expect(plain.resolution.similarityScore).toBe(88);
    expect(plain.resolution.decisionConfidence).toBe(82);
    expect(plain.resolution.status).toBe(ProductResolutionStatus.pending);
    expect(plain.resolution.candidates[0].gates.passed).toBe(true);
    expect(plain.resolution.decisions[0].action.kind).toBe(
      ResolutionActionKind.match,
    );
  });

  it('carries the listing and the product it currently sits on', () => {
    const item = ResolutionListItem.of(makeResolution(), makeState());

    const plain = instanceToPlain(item, listOptions) as Record<string, any>;

    expect(plain.resolution.sourceRecord.url).toBe(
      'https://example.test/listing/9',
    );
    expect(plain.resolution.sourceRecord.model.displayName).toBe(
      'Sony WH-1000XM5',
    );
  });

  it('carries the derived state, which is a plain object and needs exposeAll', () => {
    const item = ResolutionListItem.of(makeResolution(), makeState());

    const plain = instanceToPlain(item, listOptions) as Record<string, any>;

    expect(plain.state.availableActions).toEqual([
      { action: 'accept', requiresTargetProduct: false },
      {
        action: 'decline',
        correction: ResolutionCorrection.split,
        requiresTargetProduct: false,
      },
    ]);
    expect(plain.state.splittableSourceRecordIds).toEqual(['record-1']);
  });
});
