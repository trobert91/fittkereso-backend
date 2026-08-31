import {
  ProductResolutionFlow,
  ResolutionVerdict,
  type ProductResolutionCandidateRecord,
  type SpecMatchDetails,
} from '@fittkereso-backend/database';
import {
  ResolutionConfidenceService,
  type ResolutionConfidenceParams,
} from './resolution-confidence.service';

describe('ResolutionConfidenceService', () => {
  let service: ResolutionConfidenceService;

  beforeEach(() => {
    service = new ResolutionConfidenceService();
  });

  const candidate = (
    overrides: Partial<ProductResolutionCandidateRecord> = {},
  ): ProductResolutionCandidateRecord => ({
    candidateId: 'candidate-1',
    source: 'fuzzy',
    matchScore: 90,
    gates: { passed: true, failedGates: [] },
    ...overrides,
  });

  const specs = (overrides: Partial<SpecMatchDetails> = {}): SpecMatchDetails => ({
    comparableCount: 10,
    matchingCount: 10,
    primaryMismatches: 0,
    matcherSpecMismatches: 0,
    nonPrimaryMismatches: 0,
    details: [],
    ...overrides,
  });

  /** A resolution that matched an existing product. */
  const matched = (
    overrides: Partial<ResolutionConfidenceParams> = {},
  ): ResolutionConfidenceParams => ({
    flow: ProductResolutionFlow.product_resolution,
    seedVerdict: ResolutionVerdict.matched_existing,
    similarityScore: 92,
    candidates: [candidate()],
    specMatchDetails: specs(),
    scoring: { bestScore: 92, secondScore: 40 },
    decisionSnapshot: {
      kind: 'matcher_accept',
      confidence: 90,
      reason: 'clear match',
      selectedCandidates: [{ candidateId: 'candidate-1', confidence: 90 }],
    },
    ...overrides,
  });

  /** A resolution that matched nothing and created a new product. */
  const rejected = (
    overrides: Partial<ResolutionConfidenceParams> = {},
  ): ResolutionConfidenceParams => ({
    flow: ProductResolutionFlow.product_resolution,
    seedVerdict: ResolutionVerdict.created_new,
    similarityScore: 25,
    candidates: [
      candidate({
        matchScore: 25,
        gates: { passed: false, failedGates: ['primary_spec_mismatch'] },
      }),
    ],
    specMatchDetails: specs({ matchingCount: 2, primaryMismatches: 2 }),
    scoring: { bestScore: 25, secondScore: 20 },
    decisionSnapshot: {
      kind: 'matcher_reject',
      confidence: 0,
      reason: 'no qualifying candidate',
      selectedCandidates: [],
    },
    ...overrides,
  });

  describe('the fix: rejections are no longer all zero', () => {
    it('scores a well-evidenced rejection HIGH', () => {
      // Specs clash, gates failed, nothing looked alike. The system was right to
      // reject, and should say so. This reads 0 today.
      expect(service.compute(rejected())).toBeGreaterThan(75);
    });

    it('scores a near-miss rejection LOW', () => {
      // Everything pointed at a match and it rejected anyway — a likely missed
      // duplicate. Also reads 0 today, indistinguishable from the case above.
      const nearMiss = rejected({
        similarityScore: 93,
        candidates: [
          candidate({ matchScore: 93, gates: { passed: true, failedGates: [] } }),
        ],
        specMatchDetails: specs(),
        scoring: { bestScore: 93, secondScore: 88 },
      });

      expect(service.compute(nearMiss)).toBeLessThan(25);
    });

    it('separates the two by a wide margin — the entire point', () => {
      const confident = service.compute(rejected());
      const nearMiss = service.compute(
        rejected({
          similarityScore: 93,
          candidates: [
            candidate({ matchScore: 93, gates: { passed: true, failedGates: [] } }),
          ],
          specMatchDetails: specs(),
        }),
      );

      expect(confident - nearMiss).toBeGreaterThan(50);
    });

    it('never reads the self-report on a rejection, where it is always zero', () => {
      const breakdown = service.explain(rejected());

      expect(breakdown.components.map((c) => c.key)).not.toContain('selfReport');
      // Dropped, not zeroed — a zero would drag the score down and re-create the
      // bug in a subtler form.
      expect(breakdown.confidence).toBeGreaterThan(75);
    });
  });

  describe('acceptances', () => {
    it('scores a well-evidenced match HIGH', () => {
      expect(service.compute(matched())).toBeGreaterThan(85);
    });

    it('scores an uncorroborated match between things that do not look alike LOW', () => {
      // The cell no existing signal catches: an acceptance of two products
      // scoring 20 against each other, with nothing else vouching for it.
      const suspicious = matched({
        similarityScore: 20,
        candidates: [candidate({ matchScore: 20 })],
        specMatchDetails: specs({ matchingCount: 3 }),
        scoring: { bestScore: 20, secondScore: 15 },
      });

      expect(service.compute(suspicious)).toBeLessThan(50);
    });

    it('lets spec agreement rescue a low name similarity', () => {
      // Not a bug: a rebadged or region-renamed product has a very different
      // name and identical specs, which is what aliases exist for. Full spec
      // corroboration should pull such a match back to a middling score rather
      // than condemning it on the name alone.
      const rebadged = matched({
        similarityScore: 20,
        candidates: [candidate({ matchScore: 20 })],
        specMatchDetails: specs(),
        scoring: { bestScore: 20, secondScore: 15 },
      });
      const uncorroborated = matched({
        similarityScore: 20,
        candidates: [candidate({ matchScore: 20 })],
        specMatchDetails: specs({ matchingCount: 3 }),
        scoring: { bestScore: 20, secondScore: 15 },
      });

      expect(service.compute(rebadged)).toBeGreaterThan(
        service.compute(uncorroborated),
      );
      expect(service.compute(rebadged)).toBeLessThan(75);
    });

    it('is dragged down by a primary spec clash even when everything else agrees', () => {
      const clash = matched({
        specMatchDetails: specs({ matchingCount: 9, primaryMismatches: 1 }),
      });

      expect(service.compute(clash)).toBeLessThan(service.compute(matched()));
    });

    it('is dragged down by a narrow margin', () => {
      const narrow = matched({ scoring: { bestScore: 92, secondScore: 91 } });

      expect(service.compute(narrow)).toBeLessThan(service.compute(matched()));
    });
  });

  describe('the self-report is an input, not the answer', () => {
    it('does not simply adopt the LLM number', () => {
      const llmSaysCertain = matched({
        decisionSnapshot: {
          kind: 'llm_resolved',
          confidence: 100,
          reason: 'llm is sure',
          selectedCandidates: [{ candidateId: 'candidate-1', confidence: 100 }],
        },
        // ...but the evidence disagrees on every other axis.
        similarityScore: 30,
        candidates: [
          candidate({
            matchScore: 30,
            gates: { passed: false, failedGates: ['low_confidence'] },
          }),
        ],
        specMatchDetails: specs({ matchingCount: 1, primaryMismatches: 3 }),
        scoring: { bestScore: 30, secondScore: 29 },
      });

      expect(service.compute(llmSaysCertain)).toBeLessThan(35);
    });

    it('puts a matcher and an LLM decision on the same scale', () => {
      // Same evidence, different decider, same self-reported number: the scores
      // should be equal, because the decider's identity is not evidence.
      const viaMatcher = service.compute(matched());
      const viaLlm = service.compute(
        matched({
          decisionSnapshot: {
            kind: 'llm_resolved',
            confidence: 90,
            reason: 'llm agrees',
            selectedCandidates: [{ candidateId: 'candidate-1', confidence: 90 }],
          },
        }),
      );

      expect(viaLlm).toBe(viaMatcher);
    });
  });

  describe('corroboration — evidence independent of the name', () => {
    it('rewards a match backed by an alias hit', () => {
      const withAlias = matched({
        candidates: [
          candidate({
            matchComponents: {
              stringSimilarity: 0.6,
              tokenOverlap: 0.5,
              alphaMatch: 0.5,
              aliasMatch: true,
              specSimilarity: 0,
            },
          }),
        ],
      });
      const withoutAlias = matched({
        candidates: [
          candidate({
            matchComponents: {
              stringSimilarity: 0.6,
              tokenOverlap: 0.5,
              alphaMatch: 0.5,
              aliasMatch: false,
              specSimilarity: 0,
            },
          }),
        ],
      });

      expect(service.compute(withAlias)).toBeGreaterThan(
        service.compute(withoutAlias),
      );
    });

    it('penalises a high name score with nothing else behind it', () => {
      // `specSimilarity` is excluded from the match score and `aliasMatch` sits
      // outside it, so both are independent evidence. A name-only match is
      // weaker than its score implies.
      const nameOnly = matched({
        candidates: [
          candidate({
            matchComponents: {
              stringSimilarity: 0.95,
              tokenOverlap: 0.9,
              alphaMatch: 0.9,
              aliasMatch: false,
              specSimilarity: 0,
            },
          }),
        ],
      });

      expect(service.compute(nameOnly)).toBeLessThan(service.compute(matched()));
    });

    it('reads corroboration in reverse on a rejection', () => {
      // Independent support for sameness undercuts a decision to reject.
      const rejectedDespiteAlias = rejected({
        candidates: [
          candidate({
            matchScore: 25,
            gates: { passed: false, failedGates: ['primary_spec_mismatch'] },
            matchComponents: {
              stringSimilarity: 0.3,
              tokenOverlap: 0.2,
              alphaMatch: 0.2,
              aliasMatch: true,
              specSimilarity: 0,
            },
          }),
        ],
      });

      expect(service.compute(rejectedDespiteAlias)).toBeLessThan(
        service.compute(rejected()),
      );
    });
  });

  describe('applicability', () => {
    it('drops margin when there is no runner-up, rather than reading it as a clear win', () => {
      const breakdown = service.explain(
        matched({ scoring: { bestScore: 92, secondScore: undefined } }),
      );

      expect(breakdown.components.map((c) => c.key)).not.toContain('margin');
    });

    it('drops spec agreement when nothing was comparable', () => {
      const breakdown = service.explain(
        matched({ specMatchDetails: specs({ comparableCount: 0 }) }),
      );

      expect(breakdown.components.map((c) => c.key)).not.toContain(
        'specAgreement',
      );
    });

    it('still produces a usable score from outcome agreement alone', () => {
      const bare = service.compute({
        flow: ProductResolutionFlow.product_resolution,
        seedVerdict: ResolutionVerdict.matched_existing,
        similarityScore: 95,
      });

      expect(bare).toBeGreaterThan(90);
    });

    it('stays within 0–100 for every shape tried here', () => {
      for (const params of [matched(), rejected(), { ...matched(), similarityScore: 0 }]) {
        const value = service.compute(params);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
        expect(Number.isInteger(value)).toBe(true);
      }
    });
  });

  describe('duplicate detection', () => {
    it('scores a marginal pair lower than a near-identical one', () => {
      const pair = (similarityScore: number) =>
        service.compute({
          flow: ProductResolutionFlow.duplicate_detection,
          seedVerdict: ResolutionVerdict.duplicate_proposed,
          similarityScore,
          floor: 60,
          candidates: [
            candidate({ source: 'duplicate_detection_pair', matchScore: similarityScore }),
          ],
          specMatchDetails: specs(),
        });

      expect(pair(95)).toBeGreaterThan(pair(62));
    });
  });
});
