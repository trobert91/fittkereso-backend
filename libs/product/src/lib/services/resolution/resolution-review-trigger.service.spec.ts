import {
  ProductResolutionFlow,
  ResolutionReviewTrigger,
  ResolutionVerdict,
  type ProductResolutionCandidateRecord,
  type ProductResolutionInputSnapshot,
  type SpecMatchDetails,
} from '@fittkereso-backend/database';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import {
  ResolutionReviewTriggerService,
  type ReviewTriggerInput,
} from './resolution-review-trigger.service';

describe('ResolutionReviewTriggerService', () => {
  let service: ResolutionReviewTriggerService;

  // No overrides — the shipped defaults are what production runs, so the
  // thresholds under test are the real ones: acceptThreshold 70, ambiguityGap 5,
  // nearMissBand 10, nameOnlySpecSimilarityMax 0.05.
  beforeEach(() => {
    service = new ResolutionReviewTriggerService(
      {} as DynamicConfigService,
    );
  });

  const candidate = (
    overrides: Partial<ProductResolutionCandidateRecord> = {},
  ): ProductResolutionCandidateRecord => ({
    candidateId: 'candidate-1',
    source: 'fuzzy',
    matchScore: 92,
    matchComponents: {
      stringSimilarity: 0.95,
      tokenOverlap: 1,
      alphaMatch: 1,
      aliasMatch: false,
      specSimilarity: 0.8,
    },
    gates: { passed: true, failedGates: [] },
    ...overrides,
  });

  const specs = (
    overrides: Partial<SpecMatchDetails> = {},
  ): SpecMatchDetails => ({
    comparableCount: 10,
    matchingCount: 10,
    primaryMismatches: 0,
    matcherSpecMismatches: 0,
    nonPrimaryMismatches: 0,
    details: [],
    ...overrides,
  });

  const snapshot = (
    overrides: Partial<ProductResolutionInputSnapshot> = {},
  ): ProductResolutionInputSnapshot =>
    ({
      kind: 'product_resolution',
      input: { brand: 'Cube', model: 'Stereo Hybrid 140 HPC' },
      options: {},
      brand: { id: 'brand-1', name: 'Cube', similarity: 100 },
      category: { id: 'category-1', name: 'E-bike', similarity: 100 },
      ...overrides,
    }) as ProductResolutionInputSnapshot;

  /** A resolution that matched an existing product, with nothing wrong. */
  const matched = (
    overrides: Partial<ReviewTriggerInput> = {},
  ): ReviewTriggerInput => ({
    flow: ProductResolutionFlow.product_resolution,
    seedVerdict: ResolutionVerdict.matched_existing,
    resolvedProductId: 'candidate-1',
    candidates: [candidate(), candidate({ candidateId: 'candidate-2', matchScore: 40 })],
    specMatchDetails: specs(),
    inputSnapshot: snapshot(),
    ...overrides,
  });

  /** A resolution that matched nothing and created a new product. */
  const rejected = (
    overrides: Partial<ReviewTriggerInput> = {},
  ): ReviewTriggerInput => ({
    flow: ProductResolutionFlow.product_resolution,
    seedVerdict: ResolutionVerdict.created_new,
    candidates: [
      candidate({
        matchScore: 40,
        gates: { passed: false, failedGates: ['low_confidence'] },
      }),
    ],
    specMatchDetails: specs({ matchingCount: 3 }),
    inputSnapshot: snapshot(),
    ...overrides,
  });

  describe('the empty list, which is what auto-accept trusts', () => {
    it('fires nothing on a clean, well-corroborated match', () => {
      expect(service.triggersFor(matched())).toEqual([]);
    });

    it('fires nothing on a decisive rejection', () => {
      // Scored 40 against a threshold of 70 — nowhere near the bar, so neither
      // near-miss nor gate-only applies. The system was plainly right.
      expect(service.triggersFor(rejected())).toEqual([]);
    });
  });

  describe('spec_conflict', () => {
    it.each([
      ['a primary mismatch', specs({ matchingCount: 8, primaryMismatches: 1 })],
      ['a matcher mismatch', specs({ matchingCount: 8, matcherSpecMismatches: 1 })],
    ])('fires on %s while asserting sameness', (_label, detail) => {
      expect(
        service.triggersFor(matched({ specMatchDetails: detail })),
      ).toContain(ResolutionReviewTrigger.spec_conflict);
    });

    it('does not fire on a rejection — clashing specs support that outcome', () => {
      const conflicted = rejected({
        specMatchDetails: specs({ matchingCount: 2, primaryMismatches: 2 }),
      });
      expect(service.triggersFor(conflicted)).not.toContain(
        ResolutionReviewTrigger.spec_conflict,
      );
    });

    it('reads the subject candidate when the row carries no headline verdict', () => {
      const input = matched({
        specMatchDetails: undefined,
        candidates: [
          candidate({ specMatchDetails: specs({ primaryMismatches: 1 }) }),
        ],
      });
      expect(service.triggersFor(input)).toContain(
        ResolutionReviewTrigger.spec_conflict,
      );
    });
  });

  describe('narrow_margin', () => {
    it('fires when the top two are within the ambiguity gap', () => {
      const input = matched({
        candidates: [
          candidate({ matchScore: 88 }),
          candidate({ candidateId: 'candidate-2', matchScore: 86 }),
        ],
      });
      expect(service.triggersFor(input)).toContain(
        ResolutionReviewTrigger.narrow_margin,
      );
    });

    it('does not fire when the winner is clear', () => {
      expect(service.triggersFor(matched())).not.toContain(
        ResolutionReviewTrigger.narrow_margin,
      );
    });

    it('does not fire with a single candidate — there is no margin to be narrow', () => {
      // The same protection `ResolutionConfidenceService.margin` applies: one
      // candidate is not a photo finish, and every duplicate_detection row has
      // exactly one.
      const input = matched({ candidates: [candidate()] });
      expect(service.triggersFor(input)).not.toContain(
        ResolutionReviewTrigger.narrow_margin,
      );
    });

    it('counts a zero-scoring runner-up as a real runner-up', () => {
      const input = matched({
        candidates: [
          candidate({ matchScore: 3 }),
          candidate({ candidateId: 'candidate-2', matchScore: 0 }),
        ],
      });
      expect(service.triggersFor(input)).toContain(
        ResolutionReviewTrigger.narrow_margin,
      );
    });
  });

  describe('name_only_match', () => {
    it('fires when neither specs nor an alias back the match', () => {
      const input = matched({
        candidates: [
          candidate({
            matchComponents: {
              stringSimilarity: 0.95,
              tokenOverlap: 1,
              alphaMatch: 1,
              aliasMatch: false,
              specSimilarity: 0,
            },
          }),
        ],
      });
      expect(service.triggersFor(input)).toContain(
        ResolutionReviewTrigger.name_only_match,
      );
    });

    it('does not fire when an alias corroborates, however weak the specs', () => {
      const input = matched({
        candidates: [
          candidate({
            matchComponents: {
              stringSimilarity: 0.95,
              tokenOverlap: 1,
              alphaMatch: 1,
              aliasMatch: true,
              specSimilarity: 0,
            },
          }),
        ],
      });
      expect(service.triggersFor(input)).not.toContain(
        ResolutionReviewTrigger.name_only_match,
      );
    });
  });

  describe('gate_only_rejection', () => {
    it('fires when a candidate cleared the threshold and a gate stopped it', () => {
      const input = rejected({
        candidates: [
          candidate({
            matchScore: 85,
            gates: { passed: false, failedGates: ['critical_numeric_mismatch'] },
          }),
        ],
      });
      expect(service.triggersFor(input)).toContain(
        ResolutionReviewTrigger.gate_only_rejection,
      );
    });

    it('does not fire when the candidate failed on score alone', () => {
      // Below the bar means the threshold rejected it, not a gate — an ordinary
      // rejection with nothing to adjudicate.
      const input = rejected({
        candidates: [
          candidate({
            matchScore: 65,
            gates: { passed: false, failedGates: ['low_confidence'] },
          }),
        ],
      });
      expect(service.triggersFor(input)).not.toContain(
        ResolutionReviewTrigger.gate_only_rejection,
      );
    });
  });

  describe('near_miss_rejection', () => {
    it.each([69, 60])('fires at %d, inside the band below the threshold', (score) => {
      const input = rejected({
        candidates: [
          candidate({
            matchScore: score,
            gates: { passed: false, failedGates: ['low_confidence'] },
          }),
        ],
      });
      expect(service.triggersFor(input)).toContain(
        ResolutionReviewTrigger.near_miss_rejection,
      );
    });

    it('does not fire at 59, one point outside the band', () => {
      const input = rejected({
        candidates: [
          candidate({
            matchScore: 59,
            gates: { passed: false, failedGates: ['low_confidence'] },
          }),
        ],
      });
      expect(service.triggersFor(input)).not.toContain(
        ResolutionReviewTrigger.near_miss_rejection,
      );
    });

    it('is distinct from narrow_margin — best-vs-threshold, not best-vs-second', () => {
      // One candidate at 65: no runner-up, so no margin to be narrow, yet it is
      // squarely a near miss. The two triggers answer different questions.
      const input = rejected({
        candidates: [
          candidate({
            matchScore: 65,
            gates: { passed: false, failedGates: ['low_confidence'] },
          }),
        ],
      });
      const triggers = service.triggersFor(input);
      expect(triggers).toContain(ResolutionReviewTrigger.near_miss_rejection);
      expect(triggers).not.toContain(ResolutionReviewTrigger.narrow_margin);
    });
  });

  describe('the zero-candidate rows', () => {
    const noCandidates = (
      overrides: Partial<ReviewTriggerInput> = {},
    ): ReviewTriggerInput => ({
      flow: ProductResolutionFlow.product_resolution,
      seedVerdict: ResolutionVerdict.created_new,
      candidates: [],
      inputSnapshot: snapshot(),
      ...overrides,
    });

    it('marks an unnamed input insufficient_evidence', () => {
      const input = noCandidates({
        inputSnapshot: snapshot({
          input: { displayName: 'valami bicikli' },
          brand: undefined,
        } as Partial<ProductResolutionInputSnapshot>),
      });
      expect(service.triggersFor(input)).toEqual([
        ResolutionReviewTrigger.insufficient_evidence,
      ]);
    });

    it('flags a named input when the catalog holds that brand and category', () => {
      const input = noCandidates({ catalogHasBrandCategorySiblings: true });
      expect(service.triggersFor(input)).toEqual([
        ResolutionReviewTrigger.no_candidates_but_named,
      ]);
    });

    it('flags a named input whose brand never resolved, without any lookup', () => {
      // A brand the catalog does not know is itself the finding — an alias gap.
      // No catalog check can say more than the failed resolution already did.
      const input = noCandidates({
        inputSnapshot: snapshot({ brand: undefined }),
      });
      expect(service.triggersFor(input)).toEqual([
        ResolutionReviewTrigger.no_candidates_but_named,
      ]);
    });

    it('stays quiet for an ordinary new product in an empty catalog corner', () => {
      // The commonest shape by far, and the reason the catalog gate exists:
      // firing here would bury the two cases above in noise.
      const input = noCandidates({ catalogHasBrandCategorySiblings: false });
      expect(service.triggersFor(input)).toEqual([]);
    });

    it('stays quiet at record time, when the corner has not been looked up', () => {
      // `forRecord` runs on the scrape hot path and deliberately does no query,
      // so the trigger appears on the next nightly sweep instead.
      const input = noCandidates({ catalogHasBrandCategorySiblings: undefined });
      expect(service.triggersFor(input)).toEqual([]);
    });

    it('never fires either zero-candidate trigger on a duplicate pair', () => {
      // Detection rows always carry their one candidate; an empty list there is a
      // malformed row, not a recall miss, and neither trigger would describe it.
      const input = noCandidates({
        flow: ProductResolutionFlow.duplicate_detection,
        seedVerdict: ResolutionVerdict.duplicate_proposed,
        inputSnapshot: undefined,
      });
      expect(service.triggersFor(input)).toEqual([]);
    });
  });

  describe('duplicate_detection rows', () => {
    const pair = (
      overrides: Partial<ReviewTriggerInput> = {},
    ): ReviewTriggerInput => ({
      flow: ProductResolutionFlow.duplicate_detection,
      seedVerdict: ResolutionVerdict.duplicate_proposed,
      candidates: [
        candidate({
          source: 'duplicate_detection_pair',
          matchScore: 76,
          gates: { passed: false, failedGates: ['below_auto_merge_threshold'] },
        }),
      ],
      specMatchDetails: specs({ matchingCount: 7, comparableCount: 8 }),
      ...overrides,
    });

    it('always reads as an assertion of sameness, so spec_conflict applies', () => {
      const conflicted = pair({
        specMatchDetails: specs({ matchingCount: 5, primaryMismatches: 1 }),
      });
      expect(service.triggersFor(conflicted)).toContain(
        ResolutionReviewTrigger.spec_conflict,
      );
    });

    it('never trips the rejection triggers, which have no meaning here', () => {
      const triggers = service.triggersFor(pair());
      expect(triggers).not.toContain(ResolutionReviewTrigger.gate_only_rejection);
      expect(triggers).not.toContain(ResolutionReviewTrigger.near_miss_rejection);
    });
  });
});
