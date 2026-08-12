import type { CategoryConfigService } from '@fittkereso-backend/config';
import type {
  EvaluatedProduct,
  MatchResult,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { ScoringService } from './scoring.service';
import { CandidateScoringService } from '../matching/candidate-scoring.service';
import { InputNormalizationService } from '../matching/input-normalization.service';
import { QualityGatesService } from '../matching/quality-gates.service';
import {
  MatchingConfig,
  MatchingConfigService,
} from '../matching/matching-config.service';
import { makeTestContext } from '../testing/make-context';
import type { SlimCandidate } from '../models/slim-types';

const MATCHING_CONFIG: MatchingConfig = {
  acceptThreshold: 55,
  acceptThresholdStrict: 70,
  ambiguityGap: 5,
  defaultStrictness: 'moderate',
  defaultNumericTokenWeight: 2.5,
  ambiguityGapAnchored: 10,
};

function slim(id: string, model: string): SlimCandidate {
  return {
    productId: id,
    source: 'fuzzy',
    brand: 'Samsung',
    model,
    productCategory: { id: 'c-monitors', name: 'Monitor', slug: 'monitors' },
  };
}

function makeCandidateScoring(
  matchesByQuery: (
    input: { model?: string },
    candidates: EvaluatedProduct[],
  ) => MatchResult[],
): CandidateScoringService {
  return {
    scoreAllCandidates: jest.fn().mockImplementation(matchesByQuery),
  } as unknown as CandidateScoringService;
}

function makeQualityGates(
  passed: boolean,
  failedGates: string[] = [],
): QualityGatesService {
  const result = { passed, failedGates };
  return {
    evaluate: jest.fn().mockReturnValue(result),
    evaluateAnchored: jest.fn().mockReturnValue(result),
  } as unknown as QualityGatesService;
}

function makeInputNormalization(): InputNormalizationService {
  return new InputNormalizationService(
    { config: MATCHING_CONFIG } as unknown as MatchingConfigService,
    { getConfig: () => undefined } as unknown as CategoryConfigService,
  );
}

const NO_SPECS: ProductSpecs = {};
void NO_SPECS;

describe('ScoringService', () => {
  it('writes empty scoring snapshot when no candidates', () => {
    const service = new ScoringService(
      makeCandidateScoring(() => []),
      makeQualityGates(true),
      makeInputNormalization(),
    );

    const context = makeTestContext();
    service.score(context);

    expect(context.scoring).toEqual({ failedGates: [] });
  });

  it('annotates each candidate with matchScore + matchComponents and sorts by score desc', () => {
    const scoring = makeCandidateScoring(() => [
      {
        candidateId: 'p1',
        alias: 'g85sd',
        score: 70,
        components: {
          stringSimilarity: 0.7,
          tokenOverlap: 0.7,
          alphaMatch: 1.0,
          aliasMatch: false,
          specSimilarity: 0,
        },
      } as MatchResult,
      {
        candidateId: 'p2',
        alias: 'mpg341cqpx',
        score: 92,
        components: {
          stringSimilarity: 0.9,
          tokenOverlap: 0.9,
          alphaMatch: 1.0,
          aliasMatch: false,
          specSimilarity: 0,
        },
      } as MatchResult,
    ]);
    const service = new ScoringService(
      scoring,
      makeQualityGates(true),
      makeInputNormalization(),
    );

    const context = makeTestContext({
      input: { brand: 'Samsung', model: 'G85SD' },
      candidates: [slim('p1', 'G85SD'), slim('p2', 'MPG341CQPX')],
    });
    service.score(context);

    expect(context.candidates.map((c) => c.productId)).toEqual(['p2', 'p1']);
    expect(context.candidates[0].matchScore).toBe(92);
    expect(context.candidates[1].matchScore).toBe(70);
    expect(context.scoring?.bestCandidate?.candidateId).toBe('p2');
    expect(context.scoring?.secondScore).toBe(70);
  });

  it('uses evaluateAnchored when a reference product is set', () => {
    const scoring = makeCandidateScoring(() => [
      {
        candidateId: 'p1',
        alias: 'g85sd',
        score: 80,
        components: {
          stringSimilarity: 0.9,
          tokenOverlap: 0.9,
          alphaMatch: 1.0,
          aliasMatch: false,
          specSimilarity: 0,
        },
      } as MatchResult,
    ]);
    const qualityGates = makeQualityGates(true);
    const service = new ScoringService(
      scoring,
      qualityGates,
      makeInputNormalization(),
    );

    const context = makeTestContext({
      input: { brand: 'Samsung', model: 'G85SD' },
      candidates: [slim('p1', 'G85SD')],
      referenceProduct: {
        productId: 'ref',
        brand: 'Samsung',
        model: 'S95D',
        productCategory: {
          id: 'c-monitors',
          name: 'Monitor',
          slug: 'monitors',
        },
        specs: {},
      },
    });
    service.score(context);

    expect(qualityGates.evaluateAnchored).toHaveBeenCalled();
    expect(qualityGates.evaluate).not.toHaveBeenCalled();
  });

  it('records failedGates from the quality gate result', () => {
    const scoring = makeCandidateScoring(() => [
      {
        candidateId: 'p1',
        alias: 'g85sd',
        score: 40,
        components: {
          stringSimilarity: 0.4,
          tokenOverlap: 0.4,
          alphaMatch: 1.0,
          aliasMatch: false,
          specSimilarity: 0,
        },
      } as MatchResult,
    ]);
    const service = new ScoringService(
      scoring,
      makeQualityGates(false, ['low_confidence']),
      makeInputNormalization(),
    );

    const context = makeTestContext({
      input: { brand: 'Samsung', model: 'G85SD' },
      candidates: [slim('p1', 'G85SD')],
    });
    service.score(context);

    expect(context.scoring?.failedGates).toEqual(['low_confidence']);
  });

  describe('matcher query model fallback (reference-variant search)', () => {
    it('falls back to input.referenceModel when input.model is empty', () => {
      const scoring = makeCandidateScoring(() => []);
      const service = new ScoringService(
        scoring,
        makeQualityGates(true),
        makeInputNormalization(),
      );

      const context = makeTestContext({
        input: {
          brand: 'LG',
          model: '',
          referenceModel: 'UltraGear 34GS95QE',
          specs: [{ name: 'screenSize', value: '39"' }],
        },
        candidates: [slim('p1', 'UltraGear 39GS95QE-B')],
      });
      service.score(context);

      const callArgs = (scoring.scoreAllCandidates as jest.Mock).mock.calls[0];
      expect(callArgs[0].model).toBe('UltraGear 34GS95QE');
    });

    it('falls back to referenceProduct.model when input.model and referenceModel are both empty', () => {
      const scoring = makeCandidateScoring(() => []);
      const service = new ScoringService(
        scoring,
        makeQualityGates(true),
        makeInputNormalization(),
      );

      const context = makeTestContext({
        input: { brand: 'LG', model: '' },
        candidates: [slim('p1', '39GS95QE')],
        referenceProduct: {
          productId: 'ref-1',
          brand: 'LG',
          model: 'UltraGear 34GS95QE',
          productCategory: {
            id: 'c-monitors',
            name: 'Monitor',
            slug: 'monitors',
          },
          specs: {},
        },
      });
      service.score(context);

      const callArgs = (scoring.scoreAllCandidates as jest.Mock).mock.calls[0];
      expect(callArgs[0].model).toBe('UltraGear 34GS95QE');
    });

    it('prefers input.model when present, even with a reference set', () => {
      const scoring = makeCandidateScoring(() => []);
      const service = new ScoringService(
        scoring,
        makeQualityGates(true),
        makeInputNormalization(),
      );

      const context = makeTestContext({
        input: {
          brand: 'LG',
          model: '39GS95QE',
          referenceModel: 'UltraGear 34GS95QE',
        },
        candidates: [slim('p1', 'UltraGear 39GS95QE-B')],
        referenceProduct: {
          productId: 'ref-1',
          brand: 'LG',
          model: 'UltraGear 34GS95QE',
          productCategory: {
            id: 'c-monitors',
            name: 'Monitor',
            slug: 'monitors',
          },
          specs: {},
        },
      });
      service.score(context);

      const callArgs = (scoring.scoreAllCandidates as jest.Mock).mock.calls[0];
      expect(callArgs[0].model).toBe('39GS95QE');
    });

    it('falls through to input.displayName when no other model source is available', () => {
      const scoring = makeCandidateScoring(() => []);
      const service = new ScoringService(
        scoring,
        makeQualityGates(true),
        makeInputNormalization(),
      );

      const context = makeTestContext({
        input: { brand: 'LG', model: '', displayName: 'LG OLED' },
        candidates: [slim('p1', 'UltraGear 39GS95QE-B')],
      });
      service.score(context);

      const callArgs = (scoring.scoreAllCandidates as jest.Mock).mock.calls[0];
      expect(callArgs[0].model).toBe('LG OLED');
    });
  });
});
