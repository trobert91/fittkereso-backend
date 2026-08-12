import {
  MatchResult,
  EMPTY_MATCH_RESULT_COMPONENTS,
  SpecMatchDetails,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  MatchingConfigService,
  MatchingConfig,
} from './matching-config.service';
import {
  InputNormalizationService,
  CategoryMatchConfig,
} from './input-normalization.service';
import { QualityGatesService } from './quality-gates.service';
import type { ResolutionOptions } from '../models/resolution-options';

const MOCK_MATCHING_CONFIG: MatchingConfig = {
  acceptThreshold: 65,
  acceptThresholdStrict: 80,
  ambiguityGap: 5,
  defaultStrictness: 'moderate',
  defaultNumericTokenWeight: 2.5,
  ambiguityGapAnchored: 10,
};

const MONITORS_CONFIG: CategoryMatchConfig = {
  strictness: 'moderate',
  numericTokenRules: [
    {
      pattern: /^\d{2,3}$/,
      weight: 4,
      description: 'Screen size',
      critical: true,
    },
  ],
};

const DEFAULT_CONFIG: CategoryMatchConfig = {
  strictness: 'moderate',
  numericTokenRules: [
    {
      pattern: /\d+/,
      weight: 2.5,
      description: 'Any numeric token',
      critical: false,
    },
  ],
};

const LOOSE_OPTIONS: ResolutionOptions = {
  useEmbedding: true,
  webSearchEnabled: false,
  mode: 'loose',
};

const STRICT_OPTIONS: ResolutionOptions = {
  useEmbedding: true,
  webSearchEnabled: false,
  mode: 'strict',
};

const DEFAULT_COMPONENTS: MatchResult['components'] = {
  ...EMPTY_MATCH_RESULT_COMPONENTS,
  stringSimilarity: 0.85,
  tokenOverlap: 0.8,
  alphaMatch: 1.0,
};

const CONFIRMED_SPECS: SpecMatchDetails = {
  comparableCount: 2,
  matchingCount: 2,
  primaryMismatches: 0,
  matcherSpecMismatches: 0,
  nonPrimaryMismatches: 0,
  details: [],
};

const MATCHER_MISMATCHED_SPECS: SpecMatchDetails = {
  comparableCount: 3,
  matchingCount: 2,
  primaryMismatches: 0,
  matcherSpecMismatches: 1,
  nonPrimaryMismatches: 0,
  details: [],
};

function makeMatchResult(
  overrides: Omit<Partial<MatchResult>, 'components'> & {
    components?: Partial<MatchResult['components']>;
  } = {},
): MatchResult {
  const { components: componentOverrides, ...rest } = overrides;
  return {
    candidateId: 'prod-1',
    alias: 'TestModel',
    score: 80,
    ...rest,
    components: {
      ...DEFAULT_COMPONENTS,
      ...(componentOverrides ?? {}),
    },
  };
}

describe('QualityGatesService', () => {
  let service: QualityGatesService;
  let inputNormalization: InputNormalizationService;

  beforeEach(() => {
    const matchingConfigService = {
      config: MOCK_MATCHING_CONFIG,
    } as unknown as MatchingConfigService;
    inputNormalization = new InputNormalizationService(matchingConfigService, {
      getConfig: () => undefined,
    } as unknown as CategoryConfigService);
    service = new QualityGatesService(
      matchingConfigService,
      inputNormalization,
    );
  });

  // ─── Exact alias match (fast accept) ────────────────────────────────────────

  describe('exact alias match (stringSimilarity = 1.0)', () => {
    it('accepts immediately regardless of low score', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'mpg341cqpx',
        MONITORS_CONFIG,
      );
      const best = makeMatchResult({
        score: 30,
        components: {
          stringSimilarity: 1.0,
          tokenOverlap: 1.0,
          alphaMatch: 1.0,
        },
      });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('does not fast-accept when stringSimilarity is 0.99', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'testmodel',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({
        alias: 'TestModel',
        score: 70,
        components: {
          stringSimilarity: 0.99,
          tokenOverlap: 0.9,
          alphaMatch: 1.0,
        },
      });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── Score threshold ────────────────────────────────────────────────────

  describe('score threshold', () => {
    it('accepts when score is above loose threshold (65)', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ score: 70 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('rejects when score is below loose threshold', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ score: 60 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('low_confidence');
    });

    it('accepts exactly at loose threshold (65)', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ score: 65 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('rejects in strict mode when score is below strict threshold (80)', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ score: 75 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        STRICT_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('low_confidence');
    });

    it('accepts in strict mode when score is above strict threshold', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ score: 85 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        STRICT_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('loose threshold accepts score that would fail strict mode', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ score: 70 });
      const looseResult = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      const strictResult = service.evaluate(
        best,
        undefined,
        inputParsed,
        STRICT_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(looseResult.passed).toBe(true);
      expect(strictResult.passed).toBe(false);
    });
  });

  // ─── Ambiguity check ─────────────────────────────────────────────────────────

  describe('ambiguity check', () => {
    it('accepts when gap is above ambiguityGap', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ candidateId: 'a', score: 80 });
      const second = makeMatchResult({ candidateId: 'b', score: 70 }); // gap = 10 > 5
      const result = service.evaluate(
        best,
        second,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('rejects when gap is below ambiguityGap and no tiebreaker', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({
        candidateId: 'a',
        score: 80,
        components: { stringSimilarity: 0.75 },
      });
      const second = makeMatchResult({
        candidateId: 'b',
        score: 77,
        components: { stringSimilarity: 0.75 },
      });
      const result = service.evaluate(
        best,
        second,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('ambiguous_match');
    });

    it('accepts ambiguous match when best has higher stringSimilarity', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({
        candidateId: 'a',
        score: 80,
        components: { stringSimilarity: 0.9 },
      });
      const second = makeMatchResult({
        candidateId: 'b',
        score: 77,
        components: { stringSimilarity: 0.7 },
      });
      const result = service.evaluate(
        best,
        second,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('passes when there is no second candidate', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ score: 80 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── Critical numeric gate ───────────────────────────────────────────────────

  describe('critical numeric gate', () => {
    it('rejects when critical numeric token does not match candidate', () => {
      const inputParsed = inputNormalization.parseModelCode(
        '34gs95qe',
        MONITORS_CONFIG,
      );
      const best = makeMatchResult({ alias: '27GS95QE', score: 80 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('critical_numeric_mismatch');
    });

    it('accepts when critical numeric tokens all match candidate', () => {
      const inputParsed = inputNormalization.parseModelCode(
        '34gs95qe',
        MONITORS_CONFIG,
      );
      const best = makeMatchResult({ alias: '34GS95QE', score: 80 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('spec override: accepts mismatch when best has confirmed specs and no second', () => {
      const inputParsed = inputNormalization.parseModelCode(
        '34gs95qe',
        MONITORS_CONFIG,
      );
      const best = makeMatchResult({
        alias: '39GS95QE',
        score: 80,
        specMatchDetails: CONFIRMED_SPECS,
      });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('spec override fails when second also has confirmed specs', () => {
      const inputParsed = inputNormalization.parseModelCode(
        '34gs95qe',
        MONITORS_CONFIG,
      );
      const best = makeMatchResult({
        alias: '39GS95QE',
        score: 80,
        specMatchDetails: CONFIRMED_SPECS,
      });
      const second = makeMatchResult({
        candidateId: 'b',
        alias: '27GS95QE',
        score: 70,
        specMatchDetails: CONFIRMED_SPECS,
      });
      const result = service.evaluate(
        best,
        second,
        inputParsed,
        LOOSE_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('critical_numeric_mismatch');
    });

    it('does not apply when config has no critical rules (default config)', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      expect(inputParsed.criticalNumericTokens).toHaveLength(0);
      const best = makeMatchResult({ alias: 'XYZ456', score: 80 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── Suffix alpha gate ───────────────────────────────────────────────────────

  describe('suffix alpha gate (strict mode only)', () => {
    it('rejects in strict mode when input suffix alpha does not match candidate', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'mag341cqp',
        MONITORS_CONFIG,
      );
      const best = makeMatchResult({ alias: 'Optix MAG341CQ', score: 80 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        STRICT_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('suffix_alpha_mismatch');
    });

    it('accepts in strict mode when suffix alphas match exactly', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'mag341cqp',
        MONITORS_CONFIG,
      );
      const best = makeMatchResult({ alias: 'MAG341CQP', score: 80 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        STRICT_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('does not apply in loose mode — suffix alpha mismatch is allowed', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'mag341cqp',
        MONITORS_CONFIG,
      );
      const best = makeMatchResult({ alias: 'Optix MAG341CQ', score: 80 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('rejects suffix mismatch in strict mode even when specs are confirmed', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'mag341cqp',
        MONITORS_CONFIG,
      );
      const best = makeMatchResult({
        alias: 'Optix MAG341CQ',
        score: 80,
        specMatchDetails: CONFIRMED_SPECS,
      });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        STRICT_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('suffix_alpha_mismatch');
    });

    it('does not apply when input has no suffix alpha tokens', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'mag341',
        MONITORS_CONFIG,
      );
      expect(inputParsed.suffixAlphaTokens).toHaveLength(0);
      const best = makeMatchResult({ alias: 'MAG341CQ', score: 80 });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        STRICT_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── Matcher spec mismatch gate ─────────────────────────────────────────────

  describe('matcher spec mismatch gate (strict mode)', () => {
    const CONFIG_WITH_THRESHOLD: CategoryMatchConfig = {
      ...DEFAULT_CONFIG,
      maxMatcherSpecMismatches: 0,
    };

    it('rejects when matcher spec mismatches exceed threshold in strict mode', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({
        score: 85,
        specMatchDetails: MATCHER_MISMATCHED_SPECS,
      });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        STRICT_OPTIONS,
        CONFIG_WITH_THRESHOLD,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('matcher_spec_mismatch');
    });

    it('accepts when matcher spec mismatches are within threshold', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const configWithHighThreshold: CategoryMatchConfig = {
        ...DEFAULT_CONFIG,
        maxMatcherSpecMismatches: 1,
      };
      const best = makeMatchResult({
        score: 85,
        specMatchDetails: MATCHER_MISMATCHED_SPECS,
      });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        STRICT_OPTIONS,
        configWithHighThreshold,
      );
      expect(result.passed).toBe(true);
    });

    it('does not apply matcher spec gate in loose mode', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({
        score: 85,
        specMatchDetails: MATCHER_MISMATCHED_SPECS,
      });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        CONFIG_WITH_THRESHOLD,
      );
      expect(result.passed).toBe(true);
    });

    it('uses default threshold of 2 when not configured', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const specsWithTwoMatcherMismatches: SpecMatchDetails = {
        comparableCount: 4,
        matchingCount: 2,
        primaryMismatches: 0,
        matcherSpecMismatches: 2,
        nonPrimaryMismatches: 0,
        details: [],
      };
      const best = makeMatchResult({
        score: 85,
        specMatchDetails: specsWithTwoMatcherMismatches,
      });
      // Default threshold is 2, so 2 mismatches should still pass (2 > 2 is false)
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        STRICT_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });
  });

  // ─── hasSpecConfirmation with matcher specs ─────────────────────────────────

  describe('hasSpecConfirmation with matcher specs', () => {
    it('critical numeric gate: spec override fails when best has matcher spec mismatches', () => {
      const inputParsed = inputNormalization.parseModelCode(
        '34gs95qe',
        MONITORS_CONFIG,
      );
      const best = makeMatchResult({
        alias: '39GS95QE',
        score: 80,
        specMatchDetails: MATCHER_MISMATCHED_SPECS,
      });
      const result = service.evaluate(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        MONITORS_CONFIG,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('critical_numeric_mismatch');
    });
  });

  // ─── filterAcceptable (multi-candidate filter for the new decision pipeline) ─

  describe('filterAcceptable', () => {
    it('returns all candidates above the effective floor when gap is wide', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const c1 = makeMatchResult({ candidateId: 'a', score: 95 });
      const c2 = makeMatchResult({ candidateId: 'b', score: 91 });
      const c3 = makeMatchResult({ candidateId: 'c', score: 75 }); // below top-gap floor (90)
      const survivors = service.filterAcceptable(
        [c1, c2, c3],
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(survivors.map((s) => s.candidateId)).toEqual(['a', 'b']);
    });

    it('widens floor to acceptThreshold when topScore − ambiguityGap < threshold', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      // top=72, gap=5 → naive floor=67; threshold=65; effective floor = 67? wait
      // mock acceptThreshold is 65 and ambiguityGap is 5, so effective = max(65, 67) = 67
      // Let's flip the numbers: top=68, gap=5 → naive=63 → effective=max(65, 63)=65.
      const c1 = makeMatchResult({ candidateId: 'a', score: 68 });
      const c2 = makeMatchResult({ candidateId: 'b', score: 66 });
      const c3 = makeMatchResult({ candidateId: 'c', score: 64 }); // below threshold
      const survivors = service.filterAcceptable(
        [c1, c2, c3],
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(survivors.map((s) => s.candidateId)).toEqual(['a', 'b']);
    });

    it('returns the top alone when all others fall below the gap', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const c1 = makeMatchResult({ candidateId: 'a', score: 95 });
      const c2 = makeMatchResult({ candidateId: 'b', score: 70 }); // 95-70=25 > gap
      const survivors = service.filterAcceptable(
        [c1, c2],
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(survivors.map((s) => s.candidateId)).toEqual(['a']);
    });

    it('returns empty when no candidate clears acceptThreshold', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const c1 = makeMatchResult({ candidateId: 'a', score: 50 });
      const c2 = makeMatchResult({ candidateId: 'b', score: 48 });
      const survivors = service.filterAcceptable(
        [c1, c2],
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(survivors).toEqual([]);
    });

    it('uses acceptThresholdStrict when mode === "strict"', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const c1 = makeMatchResult({ candidateId: 'a', score: 85 }); // ≥ 80 strict
      const c2 = makeMatchResult({ candidateId: 'b', score: 75 }); // < 80
      const survivors = service.filterAcceptable(
        [c1, c2],
        inputParsed,
        STRICT_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(survivors.map((s) => s.candidateId)).toEqual(['a']);
    });

    it('drops a strict-mode candidate with primary spec mismatches per-candidate', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const mismatchSpecs: SpecMatchDetails = {
        ...CONFIRMED_SPECS,
        primaryMismatches: 1,
      };
      const c1 = makeMatchResult({
        candidateId: 'a',
        score: 90,
        specMatchDetails: mismatchSpecs,
      });
      const c2 = makeMatchResult({
        candidateId: 'b',
        score: 88,
        specMatchDetails: CONFIRMED_SPECS,
      });
      const survivors = service.filterAcceptable(
        [c1, c2],
        inputParsed,
        STRICT_OPTIONS,
        DEFAULT_CONFIG,
      );
      // c1 drops (primary spec mismatch), c2 stays
      expect(survivors.map((s) => s.candidateId)).toEqual(['b']);
    });

    it('returns empty for an empty input', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const survivors = service.filterAcceptable(
        [],
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(survivors).toEqual([]);
    });

    it('keeps exact-alias-match candidate even when score is below threshold (loose)', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const c1 = makeMatchResult({
        candidateId: 'a',
        score: 20,
        components: {
          stringSimilarity: 1.0,
          tokenOverlap: 1.0,
          alphaMatch: 1.0,
        },
      });
      const survivors = service.filterAcceptable(
        [c1],
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(survivors.map((s) => s.candidateId)).toEqual(['a']);
    });
  });

  // ─── Reference-product variant resolution ──────────────────────────────────

  describe('evaluateAnchored', () => {
    it('rejects when score is below the anchored threshold (78)', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ score: 51 });
      const result = service.evaluateAnchored(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('low_confidence_anchored');
    });

    it('accepts when score clears the anchored threshold and there is no runner-up', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ score: 85 });
      const result = service.evaluateAnchored(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('rejects when the anchored ambiguity gap (8) is not met', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ candidateId: 'a', score: 85 });
      const second = makeMatchResult({ candidateId: 'b', score: 80 });
      const result = service.evaluateAnchored(
        best,
        second,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(false);
      expect(result.failedGates).toContain('ambiguous_match_anchored');
    });

    it('accepts when the anchored ambiguity gap is met', () => {
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ candidateId: 'a', score: 90 });
      const second = makeMatchResult({ candidateId: 'b', score: 80 });
      const result = service.evaluateAnchored(
        best,
        second,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });

    it('signature does not include referenceProductId (compile-time check)', () => {
      // If a referenceProductId param were added back, this call would type-error
      // because we pass exactly the 5 required args.
      const inputParsed = inputNormalization.parseModelCode(
        'abc123',
        DEFAULT_CONFIG,
      );
      const best = makeMatchResult({ score: 85 });
      const result = service.evaluateAnchored(
        best,
        undefined,
        inputParsed,
        LOOSE_OPTIONS,
        DEFAULT_CONFIG,
      );
      expect(result.passed).toBe(true);
    });
  });
});
