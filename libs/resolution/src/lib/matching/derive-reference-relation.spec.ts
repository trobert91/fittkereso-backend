import { SpecComparisonService } from '@fittkereso-backend/product';
import type { ProductModel } from '@fittkereso-backend/database';
import { deriveReferenceRelation } from './derive-reference-relation';
import type { CategoryMatchConfig } from './input-normalization.service';
import type { ProductResolutionInput } from '../models/resolution-input';

const MATCH_CONFIG: CategoryMatchConfig = {
  strictness: 'moderate',
  numericTokenRules: [],
  primarySpecs: ['screenSize', 'panelType'],
  matcherSpecs: ['refreshRate'],
  matcherSpecHierarchies: { panelType: { OLED: ['QD-OLED'] } },
};

function makeReference(overrides: Partial<ProductModel> = {}): ProductModel {
  return {
    id: 'ref-1',
    model: 'S95D',
    specs: { screenSize: '34"', panelType: 'OLED' },
    ...overrides,
  } as unknown as ProductModel;
}

describe('deriveReferenceRelation', () => {
  let specComparison: SpecComparisonService;

  beforeEach(() => {
    specComparison = new SpecComparisonService();
  });

  it('returns none when referenceProductId is unset', () => {
    const input: ProductResolutionInput = {};
    expect(
      deriveReferenceRelation(
        input,
        makeReference(),
        MATCH_CONFIG,
        specComparison,
      ),
    ).toBe('none');
  });

  it('returns same when no clues, no spec mismatches', () => {
    const input: ProductResolutionInput = { referenceProductId: 'ref-1' };
    expect(
      deriveReferenceRelation(
        input,
        makeReference(),
        MATCH_CONFIG,
        specComparison,
      ),
    ).toBe('same');
  });

  it('returns variant when modelClues are non-empty', () => {
    const input: ProductResolutionInput = {
      referenceProductId: 'ref-1',
      modelClues: ['G85SD'],
    };
    expect(
      deriveReferenceRelation(
        input,
        makeReference(),
        MATCH_CONFIG,
        specComparison,
      ),
    ).toBe('variant');
  });

  it('returns variant when variantClues are non-empty', () => {
    const input: ProductResolutionInput = {
      referenceProductId: 'ref-1',
      variantClues: ['full-size ports'],
    };
    expect(
      deriveReferenceRelation(
        input,
        makeReference(),
        MATCH_CONFIG,
        specComparison,
      ),
    ).toBe('variant');
  });

  it('returns variant when input spec contradicts a primary spec of the reference', () => {
    const input: ProductResolutionInput = {
      referenceProductId: 'ref-1',
      specs: [{ name: 'screenSize', value: '32"' }],
    };
    expect(
      deriveReferenceRelation(
        input,
        makeReference(),
        MATCH_CONFIG,
        specComparison,
      ),
    ).toBe('variant');
  });

  it('returns same when input spec matches the reference', () => {
    const input: ProductResolutionInput = {
      referenceProductId: 'ref-1',
      specs: [{ name: 'screenSize', value: '34"' }],
    };
    expect(
      deriveReferenceRelation(
        input,
        makeReference(),
        MATCH_CONFIG,
        specComparison,
      ),
    ).toBe('same');
  });

  it('returns same when input panelType is a compatible child via matcherSpecHierarchies', () => {
    const reference = makeReference({
      specs: { screenSize: '34"', panelType: 'OLED' },
    } as Partial<ProductModel>);
    const input: ProductResolutionInput = {
      referenceProductId: 'ref-1',
      specs: [{ name: 'panelType', value: 'QD-OLED' }],
    };
    expect(
      deriveReferenceRelation(input, reference, MATCH_CONFIG, specComparison),
    ).toBe('same');
  });
});
