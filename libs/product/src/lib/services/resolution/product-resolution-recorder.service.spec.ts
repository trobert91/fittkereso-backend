import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import type { ProductResolutionRepository } from '@fittkereso-backend/database';
import {
  ResolutionActionKind,
  ResolutionActor,
  ResolutionVerdict,
} from '@fittkereso-backend/database';
import { ProductResolutionRecorderService } from './product-resolution-recorder.service';
import { ProductResolutionFingerprintService } from './product-resolution-fingerprint.service';
import { ProductResolutionPriorityService } from './product-resolution-priority.service';
import { ResolutionConfidenceService } from './resolution-confidence.service';
import { ResolutionReviewTriggerService } from './resolution-review-trigger.service';
import { ResolutionScoringService } from './resolution-scoring.service';

describe('ProductResolutionRecorderService', () => {
  let mockRepo: {
    insert: jest.Mock;
    upsertPair: jest.Mock;
    upsertByAnchor: jest.Mock;
  };
  let mockDynamicConfig: { resolution: { minScoreToRecord?: number } | undefined };
  let service: ProductResolutionRecorderService;

  beforeEach(() => {
    mockRepo = {
      insert: jest.fn().mockResolvedValue({ id: 'resolution-1' }),
      upsertPair: jest.fn().mockResolvedValue({ id: 'resolution-2' }),
      upsertByAnchor: jest
        .fn()
        .mockResolvedValue({ resolution: { id: 'resolution-3' }, outcome: 'created' }),
    };
    mockDynamicConfig = { resolution: undefined };
    // Real scoring collaborators, not mocks: the point of these tests is that a
    // recorded row carries scores derived from what was actually written, and a
    // stubbed number would assert nothing about that.
    service = new ProductResolutionRecorderService(
      mockRepo as unknown as ProductResolutionRepository,
      mockDynamicConfig as unknown as DynamicConfigService,
      new ProductResolutionFingerprintService(),
      new ResolutionScoringService(
        new ProductResolutionPriorityService(new ResolutionConfidenceService()),
        new ResolutionReviewTriggerService(
          mockDynamicConfig as unknown as DynamicConfigService,
        ),
        mockDynamicConfig as unknown as DynamicConfigService,
      ),
    );
  });

  describe('threshold resolution', () => {
    // The threshold only applies to resolutions that matched an existing
    // product, so these carry a `resolvedProductId` — without one the row is
    // recorded regardless (see the exemption tests below).
    it('falls back to the static default when no dynamic override is set', async () => {
      mockDynamicConfig.resolution = undefined;

      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord - 1,
        resolvedProductId: 'product-1',
      });
      expect(mockRepo.insert).not.toHaveBeenCalled();

      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord,
        resolvedProductId: 'product-1',
      });
      expect(mockRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('uses the dynamic config override instead of the static default', async () => {
      mockDynamicConfig.resolution = { minScoreToRecord: 90 };

      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 85,
        resolvedProductId: 'product-1',
      });
      expect(mockRepo.insert).not.toHaveBeenCalled();

      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 90,
        resolvedProductId: 'product-1',
      });
      expect(mockRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('applies the threshold to duplicate pairs with no exemption', async () => {
      // Both products already exist, so a low score really does mean the pair
      // is not worth reviewing — nothing was created as a result.
      const result = await service.recordDuplicatePair({
        flow: 'duplicate_detection' as never,
        productAId: 'a',
        productBId: 'b',
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord - 1,
      });

      expect(result).toBeNull();
      expect(mockRepo.upsertPair).not.toHaveBeenCalled();
    });
  });

  describe('the created-product exemption', () => {
    // A listing the system could not place still gets a product of its own, and
    // that product is how duplicates enter the catalog. Suppressing the row
    // because an unresolved decision reports confidence 0 would hide exactly
    // the decisions most worth reviewing.
    it('records a resolution that matched nothing, however low it scored', async () => {
      const result = await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 0,
      });

      expect(mockRepo.insert).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ id: 'resolution-1' });
    });

    it('still routes an exempted row through the anchored upsert', async () => {
      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 0,
        anchorKey: 'source-1:sku-9',
      });

      // Idempotency must not be bypassed by the exemption: a repeat scrape of
      // an unplaceable listing still must not queue a second row for it.
      expect(mockRepo.upsertByAnchor).toHaveBeenCalledTimes(1);
      expect(mockRepo.insert).not.toHaveBeenCalled();
    });

    it('does not exempt a low-scoring match to an existing product', async () => {
      const result = await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 0,
        resolvedProductId: 'product-1',
      });

      expect(result).toBeNull();
      expect(mockRepo.insert).not.toHaveBeenCalled();
      expect(mockRepo.upsertByAnchor).not.toHaveBeenCalled();
    });
  });

  describe('recordResolution', () => {
    it('appends-only when there is no anchor to key on', async () => {
      const result = await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 100,
      });

      expect(mockRepo.insert).toHaveBeenCalledTimes(1);
      expect(mockRepo.upsertByAnchor).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'resolution-1' });
    });

    it('routes through the anchored upsert when an anchor is given, so a repeat scrape cannot queue the same decision twice', async () => {
      const result = await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 100,
        anchorKey: 'source-1:sku-9',
      });

      expect(mockRepo.insert).not.toHaveBeenCalled();
      expect(mockRepo.upsertByAnchor).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ id: 'resolution-3' });

      const params = mockRepo.upsertByAnchor.mock.calls[0][0];
      expect(params.anchorKey).toBe('source-1:sku-9');
      expect(params.fingerprint).toEqual(expect.any(String));
    });

    it('seeds the log with an already-performed match when a product was resolved', async () => {
      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 100,
        resolvedProductId: 'product-1',
      });

      const seed = mockRepo.insert.mock.calls[0][0].seedDecision;
      expect(seed).toMatchObject({
        actor: ResolutionActor.system,
        verdict: ResolutionVerdict.matched_existing,
        actionPerformed: true,
      });
      expect(seed.action).toMatchObject({
        kind: ResolutionActionKind.match,
        productId: 'product-1',
      });
    });

    it('seeds a create verdict when no product was matched', async () => {
      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 100,
      });

      const seed = mockRepo.insert.mock.calls[0][0].seedDecision;
      expect(seed.verdict).toBe(ResolutionVerdict.created_new);
      expect(seed.action.kind).toBe(ResolutionActionKind.create);
    });

    // Below-threshold behaviour now depends on whether a product was matched —
    // see "the created-product exemption" above.
  });

  describe('the scores written with the row', () => {
    const record = (overrides: Record<string, unknown> = {}) =>
      service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 95,
        anchorKey: 'source-1:sku-9',
        resolvedProductId: 'product-1',
        ...overrides,
      });

    const written = () => mockRepo.upsertByAnchor.mock.calls[0][0];

    it('derives the confidence instead of copying the decider self-report', async () => {
      // The self-report is one weighted input. Adopting it wholesale is the bug
      // this replaces: it reads 0 for every rejection, because a rejection has
      // no selected candidate to take a max over.
      await record({ decisionSnapshot: { confidence: 82 } });

      expect(written().decisionConfidence).toEqual(expect.any(Number));
      expect(written().decisionConfidence).not.toBe(82);
    });

    it('writes a priority and the breakdown that accounts for it', async () => {
      await record();

      const { priority, priorityBreakdown } = written();
      expect(priority).toBeGreaterThanOrEqual(0);
      expect(priority).toBeLessThanOrEqual(100);
      expect(priorityBreakdown.priority).toBe(priority);
      expect(priorityBreakdown.confidence).toBe(written().decisionConfidence);
    });

    it('leaves blast radius unmeasured, and says so', async () => {
      // Counting the listings on the affected product would be a query per
      // scraped record. The nightly sweep measures it; the flag is how a
      // reviewer can tell the difference.
      await record();

      expect(written().priorityBreakdown.blastRadiusMeasured).toBe(false);
    });

    /** A creation that had a real candidate to reject — `similarityScore` is the
     *  best candidate's score, so a number without a candidate behind it is a
     *  shape the pipeline cannot produce. */
    const creationScoring = (score: number) => ({
      resolvedProductId: undefined,
      similarityScore: score,
      candidates: [
        {
          candidateId: 'candidate-1',
          source: 'fuzzy' as const,
          matchScore: score,
          gates: { passed: false, failedGates: ['low_confidence'] },
        },
      ],
    });

    it('ranks a near-miss creation above an obviously-new listing', async () => {
      // Both created a product. The one that scored 95 against an existing
      // product and still got its own is how duplicates enter the catalog; the
      // one that resembled nothing is simply a new product.
      await record(creationScoring(95));
      await record(creationScoring(5));

      const [nearMiss, obviouslyNew] = mockRepo.upsertByAnchor.mock.calls;
      expect(nearMiss[0].priority).toBeGreaterThan(obviouslyNew[0].priority);
    });

    it('refuses to claim confidence in a creation it found nothing to compare', async () => {
      // The old failure: with no candidates every component but outcomeAgreement
      // drops out, that one renormalizes to full weight, and "found nothing,
      // called it new — consistent!" scored 100. Absence of evidence read as
      // agreement, on exactly the rows the recorder goes out of its way to keep.
      // See `resolution-scoring.service.spec.ts` for the explained-pool case that
      // stops this from lifting every ordinary new product.
      await record({ similarityScore: 0, resolvedProductId: undefined });

      expect(written().decisionConfidence).toBe(0);
      expect(written().priority).toBeGreaterThan(0);
    });

    it('writes them on the anchorless path too', async () => {
      // The ad-hoc admin endpoint has no anchor and goes straight to insert —
      // it must not produce an unranked row that sorts last forever.
      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 95,
        resolvedProductId: 'product-1',
      });

      expect(mockRepo.insert.mock.calls[0][0].priority).toEqual(
        expect.any(Number),
      );
    });

    it('scores a duplicate pair against the recording threshold it cleared', async () => {
      // Every recorded pair sits above minScoreToRecord, so raw scores bunch up
      // at the top. A pair barely over the line must not read as a near-certain
      // duplicate.
      mockDynamicConfig.resolution = { minScoreToRecord: 60 };

      await service.recordDuplicatePair({
        flow: 'duplicate_detection' as never,
        productAId: 'a',
        productBId: 'b',
        similarityScore: 62,
      });
      await service.recordDuplicatePair({
        flow: 'duplicate_detection' as never,
        productAId: 'c',
        productBId: 'd',
        similarityScore: 98,
      });

      const [marginal, nearIdentical] = mockRepo.upsertPair.mock.calls;
      expect(marginal[0].decisionConfidence).toBeLessThan(
        nearIdentical[0].decisionConfidence,
      );
      expect(marginal[0].priority).toBeGreaterThan(nearIdentical[0].priority);
    });
  });

  describe('record-time auto-accept', () => {
    /** A clean cross-source match: one candidate that passed every gate, scored
     *  high, and nothing for a trigger to object to. */
    const cleanMatch = (overrides: Record<string, unknown> = {}) =>
      service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 98,
        anchorKey: 'source-1:sku-clean',
        resolvedProductId: 'product-1',
        candidates: [
          {
            candidateId: 'product-1',
            source: 'fuzzy' as never,
            matchScore: 98,
            matchComponents: {
              stringSimilarity: 0.97,
              tokenOverlap: 1,
              alphaMatch: 1,
              aliasMatch: true,
              specSimilarity: 0.9,
            },
            gates: { passed: true, failedGates: [] },
          },
        ],
        specMatchDetails: {
          comparableCount: 6,
          matchingCount: 6,
          primaryMismatches: 0,
          matcherSpecMismatches: 0,
          nonPrimaryMismatches: 0,
          details: [],
        },
        decisionSnapshot: {
          kind: 'matcher_accept' as never,
          confidence: 98,
          reason: 'matcher_accept',
          selectedCandidates: [{ candidateId: 'product-1', confidence: 98 }],
        },
        ...overrides,
      } as never);

    const written = () => mockRepo.upsertByAnchor.mock.calls[0][0];

    beforeEach(() => {
      mockDynamicConfig.resolution = {
        automation: { deterministic: { dryRun: false } },
      } as never;
    });

    it('settles a trusted row before it ever reaches the queue', async () => {
      await cleanMatch();

      const { autoAccept, decisionConfidence } = written();
      expect(decisionConfidence).toBeGreaterThanOrEqual(90);
      expect(autoAccept?.decidedBy).toBe('system');
    });

    it('records why, as a second log entry beside the seed', async () => {
      // The licence for closing a row without asking is that the close can be
      // explained and reopened. An unexplained `done` would be neither.
      await cleanMatch();

      const { autoAccept } = written();
      expect(autoAccept.decision.actor).toBe('system');
      expect(autoAccept.decision.verdict).toBe('accept');
      // Nothing to carry out — the seed already performed the match. This is
      // what makes the deterministic path structurally non-destructive.
      expect(autoAccept.decision.action.kind).toBe('none');
      expect(autoAccept.decision.actionPerformed).toBe(false);
      expect(autoAccept.decision.note).toContain('no review trigger fired');
    });

    it('scores the row as done, not as the pending row it never was', async () => {
      // `status` feeds `statusWeight`, so a row written `done` while scored
      // `pending` would carry a priority describing a queue position it never
      // occupied.
      await cleanMatch();

      expect(written().priorityBreakdown.statusWeight).toBeLessThan(1);
    });

    it('leaves a row alone when a trigger fired', async () => {
      // Two candidates two points apart — `narrow_margin`, which exists to block
      // exactly this: the margin term is too lightly weighted to stop a coin-flip
      // clearing 90 on its own.
      await cleanMatch({
        candidates: [
          {
            candidateId: 'product-1',
            source: 'fuzzy',
            matchScore: 96,
            gates: { passed: true, failedGates: [] },
          },
          {
            candidateId: 'product-2',
            source: 'fuzzy',
            matchScore: 94,
            gates: { passed: true, failedGates: [] },
          },
        ],
      });

      expect(written().reviewTriggers).toContain('narrow_margin');
      expect(written().autoAccept).toBeUndefined();
    });

    it('never settles a duplicate pair', async () => {
      await service.recordDuplicatePair({
        flow: 'duplicate_detection' as never,
        productAId: 'a',
        productBId: 'b',
        similarityScore: 99,
      });

      expect(mockRepo.upsertPair.mock.calls[0][0].autoAccept).toBeUndefined();
    });

    it('writes nothing in dryRun, however trusted the row', async () => {
      // The first night is meant to be readable, not consequential.
      mockDynamicConfig.resolution = {
        automation: { deterministic: { dryRun: true } },
      } as never;

      await cleanMatch();

      expect(written().autoAccept).toBeUndefined();
      expect(written().decisionConfidence).toBeGreaterThanOrEqual(90);
    });

    it('does nothing at record time when that call site is switched off', async () => {
      mockDynamicConfig.resolution = {
        automation: { deterministic: { dryRun: false, atRecordTime: false } },
      } as never;

      await cleanMatch();

      expect(written().autoAccept).toBeUndefined();
    });

    it('does nothing when automation is off entirely', async () => {
      mockDynamicConfig.resolution = {
        automation: { enabled: false, deterministic: { dryRun: false } },
      } as never;

      await cleanMatch();

      expect(written().autoAccept).toBeUndefined();
    });
  });

  describe('recordDuplicatePair', () => {
    const pairParams = {
      flow: 'duplicate_detection' as never,
      productAId: 'a',
      productBId: 'b',
      similarityScore: 75,
    };

    it('calls repo.upsertPair (not insert) when the score clears the threshold, using the same shared gate', async () => {
      const result = await service.recordDuplicatePair(pairParams);

      expect(mockRepo.upsertPair).toHaveBeenCalledTimes(1);
      expect(mockRepo.insert).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'resolution-2' });
    });

    it('anchors the pair on its ordered ids so either argument order dedupes to one row', async () => {
      await service.recordDuplicatePair(pairParams);
      await service.recordDuplicatePair({
        ...pairParams,
        productAId: 'b',
        productBId: 'a',
      });

      const [first, second] = mockRepo.upsertPair.mock.calls;
      expect(first[0].anchorKey).toBe('a:b');
      expect(second[0].anchorKey).toBe('a:b');
    });

    it('seeds an UNPERFORMED merge, because detection proposes but never merges', async () => {
      await service.recordDuplicatePair(pairParams);

      const seed = mockRepo.upsertPair.mock.calls[0][0].seedDecision;
      expect(seed).toMatchObject({
        actor: ResolutionActor.system,
        verdict: ResolutionVerdict.duplicate_proposed,
        actionPerformed: false,
      });
      expect(seed.action.kind).toBe(ResolutionActionKind.merge);
    });

    it('returns null and never calls the repository when below threshold', async () => {
      const result = await service.recordDuplicatePair({
        ...pairParams,
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord - 1,
      });

      expect(result).toBeNull();
      expect(mockRepo.upsertPair).not.toHaveBeenCalled();
    });
  });
});
