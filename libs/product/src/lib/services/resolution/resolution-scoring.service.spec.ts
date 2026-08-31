import {
  ProductResolution,
  ProductResolutionFlow,
  ProductResolutionStatus,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionVerdict,
  type ProductResolutionCandidateRecord,
  type ProductResolutionDecisionEntry,
} from '@fittkereso-backend/database';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { ProductResolutionPriorityService } from './product-resolution-priority.service';
import { ResolutionConfidenceService } from './resolution-confidence.service';
import {
  ResolutionScoringService,
  type RecordScoringInput,
} from './resolution-scoring.service';

describe('ResolutionScoringService', () => {
  let config: { resolution?: { minScoreToRecord?: number } };
  let service: ResolutionScoringService;

  beforeEach(() => {
    config = { resolution: { minScoreToRecord: 60 } };
    service = new ResolutionScoringService(
      new ProductResolutionPriorityService(new ResolutionConfidenceService()),
      config as unknown as DynamicConfigService,
    );
  });

  const candidate = (
    overrides: Partial<ProductResolutionCandidateRecord> = {},
  ): ProductResolutionCandidateRecord => ({
    candidateId: 'candidate-1',
    source: 'fuzzy',
    matchScore: 88,
    gates: { passed: true, failedGates: [] },
    ...overrides,
  });

  const seed = (
    overrides: Partial<ProductResolutionDecisionEntry> = {},
  ): ProductResolutionDecisionEntry => ({
    at: new Date().toISOString(),
    actor: ResolutionActor.system,
    verdict: ResolutionVerdict.matched_existing,
    action: { kind: ResolutionActionKind.match, productId: 'product-1' },
    actionPerformed: true,
    ...overrides,
  });

  const recordInput = (
    overrides: Partial<RecordScoringInput> = {},
  ): RecordScoringInput => ({
    flow: ProductResolutionFlow.product_resolution,
    similarityScore: 88,
    resolvedProductId: 'product-1',
    candidates: [candidate(), candidate({ candidateId: 'candidate-2', matchScore: 40 })],
    specMatchDetails: {
      comparableCount: 8,
      matchingCount: 7,
      primaryMismatches: 0,
      matcherSpecMismatches: 0,
      nonPrimaryMismatches: 0,
      details: [],
    },
    decisionSnapshot: {
      kind: 'matcher_accept',
      confidence: 88,
      reason: 'clear match',
      selectedCandidates: [{ candidateId: 'candidate-1', confidence: 88 }],
    },
    seedDecision: seed(),
    ...overrides,
  });

  /** The same situation, as it looks once written. */
  const asRow = (input: RecordScoringInput): ProductResolution =>
    ({
      flow: input.flow,
      similarityScore: input.similarityScore,
      status: ProductResolutionStatus.pending,
      resolvedProduct: input.resolvedProductId
        ? { id: input.resolvedProductId }
        : null,
      candidates: input.candidates,
      specMatchDetails: input.specMatchDetails,
      decisionSnapshot: input.decisionSnapshot,
      decisions: input.seedDecision ? [input.seedDecision] : [],
      lastSeenAt: new Date(),
    }) as ProductResolution;

  describe('the two entry points agree', () => {
    it('scores a freshly written row the same as the sweep would', () => {
      // If they disagreed, every row's rank would jump the first time the sweep
      // touched it, for no reason a reviewer could see.
      const input = recordInput();

      expect(service.forRow(asRow(input), undefined)).toEqual(
        service.forRecord(input),
      );
    });

    it('agrees on a created product too, where the catalog link misleads', () => {
      // `resolvedProduct` is backfilled for created products as well, so a row
      // read naively looks like a match. The seed verdict is what keeps the two
      // paths reading it the same way.
      const input = recordInput({
        resolvedProductId: undefined,
        seedDecision: seed({
          verdict: ResolutionVerdict.created_new,
          action: { kind: ResolutionActionKind.create },
        }),
      });
      const row = asRow(input);
      row.resolvedProduct = { id: 'product-backfilled' } as never;

      expect(service.forRow(row).decisionConfidence).toBe(
        service.forRecord(input).decisionConfidence,
      );
    });
  });

  describe('scoring read off the candidates', () => {
    it('takes the margin from the top two stored scores', () => {
      const wide = service.forRecord(recordInput());
      const narrow = service.forRecord(
        recordInput({
          candidates: [
            candidate(),
            candidate({ candidateId: 'candidate-2', matchScore: 87 }),
          ],
        }),
      );

      expect(wide.decisionConfidence).toBeGreaterThan(narrow.decisionConfidence);
    });

    it('treats a candidate that scored zero as a real runner-up', () => {
      // A falsy-value filter here would drop it, read as "no second candidate",
      // and silently remove the margin component instead of scoring it as the
      // decisive win it was.
      const withZero = service.forRecord(
        recordInput({
          candidates: [
            candidate(),
            candidate({ candidateId: 'candidate-2', matchScore: 0 }),
          ],
        }),
      );
      const alone = service.forRecord(
        recordInput({ candidates: [candidate()] }),
      );

      expect(withZero.decisionConfidence).not.toBe(alone.decisionConfidence);
    });
  });

  describe('the recording floor', () => {
    it('rescales duplicate pairs, which are all above the threshold', () => {
      const pair = (similarityScore: number) =>
        service.forRecord({
          flow: ProductResolutionFlow.duplicate_detection,
          similarityScore,
          candidates: [candidate({ matchScore: similarityScore })],
          seedDecision: seed({
            verdict: ResolutionVerdict.duplicate_proposed,
            action: { kind: ResolutionActionKind.merge },
            actionPerformed: false,
          }),
        });

      config.resolution = { minScoreToRecord: 60 };
      const withFloor = pair(62).decisionConfidence;
      config.resolution = { minScoreToRecord: 0 };
      const withoutFloor = pair(62).decisionConfidence;

      // Against the floor it actually cleared, a 62 is a marginal pair rather
      // than a fairly convincing one.
      expect(withFloor).toBeLessThan(withoutFloor);
    });

    it('does not rescale the resolution flow, whose scores are not truncated', () => {
      // A listing that matched nothing is recorded however low it scored, so
      // that flow's distribution runs the full range.
      const input = recordInput({ similarityScore: 62 });

      config.resolution = { minScoreToRecord: 60 };
      const high = service.forRecord(input).decisionConfidence;
      config.resolution = { minScoreToRecord: 0 };

      expect(service.forRecord(input).decisionConfidence).toBe(high);
    });
  });

  describe('what only the sweep can see', () => {
    it('marks a record-time score as having assumed the blast radius', () => {
      expect(
        service.forRecord(recordInput()).priorityBreakdown.blastRadiusMeasured,
      ).toBe(false);
    });

    it('marks a swept score as measured, and lets it move the priority', () => {
      const input = recordInput();
      const big = service.forRow(asRow(input), {
        sourceRecords: 200,
        offers: 200,
      });
      const small = service.forRow(asRow(input), {
        sourceRecords: 1,
        offers: 0,
      });

      expect(big.priorityBreakdown.blastRadiusMeasured).toBe(true);
      expect(big.priority).toBeGreaterThan(small.priority);
    });

    it('retires a superseded row, which only the row itself knows', () => {
      const row = asRow(recordInput());
      row.status = ProductResolutionStatus.superseded;

      expect(service.forRow(row).priority).toBe(0);
    });
  });
});
