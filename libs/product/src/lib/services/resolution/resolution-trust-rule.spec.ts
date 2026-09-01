import {
  ProductResolutionFlow,
  ProductResolutionStatus,
  ResolutionReviewTrigger,
  type ProductResolutionCandidateRecord,
} from '@fittkereso-backend/database';
import {
  isDeterministicallyTrusted,
  trustRuleRejection,
  type TrustRuleSubject,
} from './resolution-trust-rule';

describe('the deterministic trust rule', () => {
  const config = { minConfidence: 90 };

  const candidate = (): ProductResolutionCandidateRecord => ({
    candidateId: 'candidate-1',
    source: 'fuzzy',
    matchScore: 96,
    gates: { passed: true, failedGates: [] },
  });

  /** A row the rule should settle: a clean, well-scored resolution nobody has
   *  touched and nothing objected to. */
  const trusted = (
    overrides: Partial<TrustRuleSubject> = {},
  ): TrustRuleSubject => ({
    flow: ProductResolutionFlow.product_resolution,
    status: ProductResolutionStatus.pending,
    reviewedAt: null,
    decisionConfidence: 96,
    reviewTriggers: [],
    candidates: [candidate()],
    ...overrides,
  });

  it('accepts the clean case', () => {
    expect(isDeterministicallyTrusted(trusted(), config)).toBe(true);
  });

  describe('the non-destructive guarantee', () => {
    it('never settles a duplicate pair, however confident', () => {
      // The load-bearing restriction. A product_resolution row carries a seed
      // entry that already performed its action, so accepting is a confirmation.
      // A duplicate pair is a proposal — accepting it *executes a merge*, which
      // no score alone should authorise. Those go to the AI, which reads the
      // evidence first.
      const pair = trusted({
        flow: ProductResolutionFlow.duplicate_detection,
        decisionConfidence: 100,
      });

      expect(trustRuleRejection(pair, config)).toBe('wrong_flow');
    });
  });

  describe('the automation rail', () => {
    it('never overrules a human, whatever else the row says', () => {
      const touched = trusted({ reviewedAt: new Date() });

      expect(trustRuleRejection(touched, config)).toBe('human_touched');
    });

    it('keeps away from a row a human reopened', () => {
      // A reopen sets `status: pending` again, so the status clause alone would
      // wave it straight back through. `reviewedAt` is what makes the row stay
      // the human's — permanently, until a rescrape supersedes it.
      const reopened = trusted({
        status: ProductResolutionStatus.pending,
        reviewedAt: new Date(),
      });

      expect(isDeterministicallyTrusted(reopened, config)).toBe(false);
    });

    it.each([
      ProductResolutionStatus.done,
      ProductResolutionStatus.failed,
      ProductResolutionStatus.superseded,
    ])('leaves a %s row alone', (status) => {
      expect(trustRuleRejection(trusted({ status }), config)).toBe('not_open');
    });

    it('treats an absent status as a row about to be written', () => {
      // The record-time path tests a situation, not a stored row — there is no
      // status yet, and nothing to be non-open about.
      const { status: _status, ...situation } = trusted();

      expect(isDeterministicallyTrusted(situation as TrustRuleSubject, config)).toBe(
        true,
      );
    });
  });

  describe('what the triggers are trusted to mean', () => {
    it('refuses an unclassified row rather than reading it as clean', () => {
      // `null` means the sweep has never looked. The whole licence for closing
      // rows automatically is that something checked them first.
      expect(trustRuleRejection(trusted({ reviewTriggers: null }), config)).toBe(
        'unclassified',
      );
      expect(
        trustRuleRejection(trusted({ reviewTriggers: undefined }), config),
      ).toBe('unclassified');
    });

    it('refuses a row where anything fired, however high the confidence', () => {
      const flagged = trusted({
        decisionConfidence: 99,
        reviewTriggers: [ResolutionReviewTrigger.narrow_margin],
      });

      expect(trustRuleRejection(flagged, config)).toBe('triggered');
    });
  });

  describe('the confidence floor', () => {
    it('accepts exactly at the threshold and refuses one below', () => {
      expect(
        isDeterministicallyTrusted(trusted({ decisionConfidence: 90 }), config),
      ).toBe(true);
      expect(
        trustRuleRejection(trusted({ decisionConfidence: 89 }), config),
      ).toBe('below_confidence');
    });

    it('refuses an unscored row', () => {
      expect(
        trustRuleRejection(trusted({ decisionConfidence: null }), config),
      ).toBe('below_confidence');
    });
  });

  describe('the belt-and-braces candidate check', () => {
    it('refuses a row with no candidates even at confidence 100', () => {
      // Confidence should no longer reach 100 from an empty pool — that was the
      // §3.1 fix. This clause does not delegate to that: it is the last thing
      // standing between a scoring regression and an auto-closed queue.
      const empty = trusted({ decisionConfidence: 100, candidates: [] });

      expect(trustRuleRejection(empty, config)).toBe('no_candidates');
    });
  });

  it('reports the cheapest failing clause first', () => {
    // A row that fails several at once should name the structural reason, not a
    // numeric one — that is what makes a dryRun log readable.
    const hopeless = trusted({
      flow: ProductResolutionFlow.duplicate_detection,
      reviewedAt: new Date(),
      decisionConfidence: 10,
      reviewTriggers: null,
      candidates: [],
    });

    expect(trustRuleRejection(hopeless, config)).toBe('wrong_flow');
  });
});
