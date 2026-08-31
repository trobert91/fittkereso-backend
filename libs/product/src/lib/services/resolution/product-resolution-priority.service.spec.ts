import {
  ProductResolutionFlow,
  ProductResolutionStatus,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionVerdict,
  type ProductResolutionDecisionEntry,
} from '@fittkereso-backend/database';
import { ResolutionConfidenceService } from './resolution-confidence.service';
import {
  ProductResolutionPriorityService,
  type ProductResolutionPriorityParams,
} from './product-resolution-priority.service';

describe('ProductResolutionPriorityService', () => {
  let service: ProductResolutionPriorityService;

  beforeEach(() => {
    service = new ProductResolutionPriorityService(
      new ResolutionConfidenceService(),
    );
  });

  const performed = (
    kind: ResolutionActionKind,
    sourceRecordIds?: string[],
  ): ProductResolutionDecisionEntry => ({
    at: new Date().toISOString(),
    actor: ResolutionActor.system,
    verdict: ResolutionVerdict.matched_existing,
    action: { kind, sourceRecordIds },
    actionPerformed: true,
  });

  /** An uncertain decision: it matched two things that do not look alike and
   *  nothing corroborates it. */
  const uncertain = (
    overrides: Partial<ProductResolutionPriorityParams> = {},
  ): ProductResolutionPriorityParams => ({
    flow: ProductResolutionFlow.product_resolution,
    status: ProductResolutionStatus.pending,
    seedVerdict: ResolutionVerdict.matched_existing,
    similarityScore: 20,
    scoring: { bestScore: 20, secondScore: 19 },
    specMatchDetails: {
      comparableCount: 10,
      matchingCount: 2,
      primaryMismatches: 2,
      matcherSpecMismatches: 0,
      nonPrimaryMismatches: 0,
      details: [],
    },
    lastPerformed: performed(ResolutionActionKind.match),
    blastRadius: { sourceRecords: 20, offers: 20 },
    ...overrides,
  });

  /** A decision nobody needs to look at: clear match, everything agrees. */
  const certain = (
    overrides: Partial<ProductResolutionPriorityParams> = {},
  ): ProductResolutionPriorityParams =>
    uncertain({
      similarityScore: 96,
      scoring: { bestScore: 96, secondScore: 20 },
      specMatchDetails: {
        comparableCount: 10,
        matchingCount: 10,
        primaryMismatches: 0,
        matcherSpecMismatches: 0,
        nonPrimaryMismatches: 0,
        details: [],
      },
      ...overrides,
    });

  describe('the multiplication is the design', () => {
    it('ranks an uncertain decision on a big product at the top', () => {
      expect(service.compute(uncertain())).toBeGreaterThan(60);
    });

    it('retires a certain decision however much rides on it', () => {
      // The case the old ordering got wrong: high similarity, obviously right,
      // sitting at the top of the queue purely because it scored well.
      expect(
        service.compute(certain({ blastRadius: { sourceRecords: 200, offers: 200 } })),
      ).toBeLessThan(20);
    });

    it('retires an uncertain decision that touches almost nothing', () => {
      const trivial = service.compute(
        uncertain({ blastRadius: { sourceRecords: 1, offers: 0 } }),
      );

      expect(trivial).toBeLessThan(service.compute(uncertain()));
    });

    it('never reaches zero on uncertainty alone — impact is floored', () => {
      // "Touches almost nothing" is still wrong, and must stay reachable.
      expect(
        service.compute(uncertain({ blastRadius: { sourceRecords: 0, offers: 0 } })),
      ).toBeGreaterThan(0);
    });
  });

  describe('blast radius', () => {
    it('scales with diminishing returns', () => {
      const at = (sourceRecords: number) =>
        service.compute(uncertain({ blastRadius: { sourceRecords, offers: 0 } }));

      // 1 → 10 should move the score much more than 30 → 40.
      expect(at(10) - at(1)).toBeGreaterThan(at(40) - at(30));
    });

    it('assumes a mid-range value when it has not been counted', () => {
      const assumed = service.explain(
        uncertain({ blastRadius: undefined }),
      );

      expect(assumed.blastRadiusMeasured).toBe(false);
      // Neither leads the queue nor vanishes from it before the sweep lands.
      expect(assumed.priority).toBeGreaterThan(0);
      expect(assumed.impactFactors.find((f) => f.key === 'blastRadius')?.value).toBe(
        0.5,
      );
    });
  });

  describe('what is at stake', () => {
    it('scores an unperformed proposal highest — accepting it deletes a product', () => {
      const proposal = service.explain(uncertain({ lastPerformed: undefined }));
      const alreadyMatched = service.explain(uncertain());

      expect(proposal.priority).toBeGreaterThan(alreadyMatched.priority);
    });

    it('ranks a wrongly-created product above a wrongly-matched listing', () => {
      const created = service.compute(
        uncertain({ lastPerformed: performed(ResolutionActionKind.create) }),
      );
      const matched = service.compute(
        uncertain({ lastPerformed: performed(ResolutionActionKind.match) }),
      );

      expect(created).toBeGreaterThan(matched);
    });

    it('weighs a merge by how many listings it moved', () => {
      const wide = service.compute(
        uncertain({
          lastPerformed: performed(
            ResolutionActionKind.merge,
            Array.from({ length: 30 }, (_, i) => `record-${i}`),
          ),
        }),
      );
      const narrow = service.compute(
        uncertain({
          lastPerformed: performed(ResolutionActionKind.merge, ['record-1']),
        }),
      );

      expect(wide).toBeGreaterThan(narrow);
    });
  });

  describe('status', () => {
    it('zeroes a superseded row — there is nothing to decide', () => {
      expect(
        service.compute(
          uncertain({ status: ProductResolutionStatus.superseded }),
        ),
      ).toBe(0);
    });

    it('sinks a decided row without hiding it, so a mis-click stays re-openable', () => {
      const done = service.compute(
        uncertain({ status: ProductResolutionStatus.done }),
      );

      expect(done).toBeGreaterThan(0);
      expect(done).toBeLessThan(
        service.compute(uncertain({ status: ProductResolutionStatus.pending })),
      );
    });

    it('keeps a failed row at full weight — it is broken either way', () => {
      expect(
        service.compute(uncertain({ status: ProductResolutionStatus.failed })),
      ).toBe(service.compute(uncertain({ status: ProductResolutionStatus.pending })));
    });
  });

  describe('staleness', () => {
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    it('does not penalise a recently seen listing', () => {
      expect(service.compute(uncertain({ lastSeenAt: daysAgo(5) }))).toBe(
        service.compute(uncertain({ lastSeenAt: null })),
      );
    });

    it('sinks a listing that has not been scraped in a long time', () => {
      expect(
        service.compute(uncertain({ lastSeenAt: daysAgo(300) })),
      ).toBeLessThan(service.compute(uncertain({ lastSeenAt: daysAgo(5) })));
    });

    it('tapers rather than cliffs — an ancient row is still reachable', () => {
      expect(
        service.compute(uncertain({ lastSeenAt: daysAgo(5000) })),
      ).toBeGreaterThan(0);
    });

    it('ignores an unparseable timestamp instead of scoring zero', () => {
      expect(
        service.compute(uncertain({ lastSeenAt: 'not-a-date' })),
      ).toBe(service.compute(uncertain({ lastSeenAt: null })));
    });
  });

  describe('the breakdown', () => {
    it('accounts for the score, so a surprising rank can be traced', () => {
      const breakdown = service.explain(uncertain());

      expect(
        Math.round(
          100 *
            breakdown.uncertainty *
            breakdown.impact *
            breakdown.statusWeight,
        ),
      ).toBe(breakdown.priority);
    });

    it('carries the confidence it was derived from', () => {
      const breakdown = service.explain(uncertain());

      expect(breakdown.confidence).toBeGreaterThanOrEqual(0);
      expect(breakdown.uncertainty).toBeCloseTo(1 - breakdown.confidence / 100);
    });
  });

  describe('bounds', () => {
    it('stays within 0–100 across every shape tried here', () => {
      const shapes = [
        uncertain(),
        certain(),
        uncertain({ status: ProductResolutionStatus.superseded }),
        uncertain({ blastRadius: { sourceRecords: 10_000, offers: 10_000 } }),
        { ...uncertain(), similarityScore: Number.NaN },
      ];

      for (const shape of shapes) {
        const value = service.compute(shape);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    });
  });
});
