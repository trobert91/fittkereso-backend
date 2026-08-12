import type {
  ProductModel,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { SpecComparisonService } from '@fittkereso-backend/product';
import type { CategoryConfigService } from '@fittkereso-backend/config';
import {
  ReferenceProductResolver,
  buildReferenceVariantInput,
} from './reference-product-resolver';
import { InputNormalizationService } from '../matching/input-normalization.service';
import {
  MatchingConfig,
  MatchingConfigService,
} from '../matching/matching-config.service';
import { makeTestContext } from '../testing/make-context';

const MATCHING_CONFIG: MatchingConfig = {
  acceptThreshold: 55,
  acceptThresholdStrict: 70,
  ambiguityGap: 5,
  defaultStrictness: 'moderate',
  defaultNumericTokenWeight: 2.5,
  ambiguityGapAnchored: 10,
};

const MONITORS_CONFIG = {
  matchingConfig: { strictness: 'moderate' as const },
  primarySpecs: ['screenSize', 'panelType'],
  matcherSpecHierarchies: { panelType: { OLED: ['QD-OLED'] } },
};

class StubCategoryConfigService {
  getConfig(slug: string): unknown {
    if (slug === 'monitors') return MONITORS_CONFIG;
    return undefined;
  }
}

function makeRepo(
  byId: Record<string, ProductModel> = {},
  throws = false,
): ProductModelRepository {
  return {
    findByIdForPipeline: jest.fn().mockImplementation(async (id: string) => {
      if (throws) throw new Error('repo down');
      return byId[id] ?? null;
    }),
  } as unknown as ProductModelRepository;
}

function makeReferenceProduct(
  overrides: Partial<ProductModel> = {},
): ProductModel {
  return {
    id: 'ref-1',
    model: 'S95D',
    displayName: 'Samsung S95D OLED',
    brand: { id: 'brand-1', name: 'Samsung' },
    productCategory: {
      id: 'cat-monitors',
      name: 'Monitor',
      slug: 'monitors',
    },
    specs: { screenSize: '34"', panelType: 'OLED' },
    ...overrides,
  } as unknown as ProductModel;
}

function makeResolver(repo: ProductModelRepository): ReferenceProductResolver {
  const matchingConfigService = {
    config: MATCHING_CONFIG,
  } as unknown as MatchingConfigService;
  const inputNormalization = new InputNormalizationService(
    matchingConfigService,
    new StubCategoryConfigService() as unknown as CategoryConfigService,
  );
  return new ReferenceProductResolver(
    repo,
    new SpecComparisonService(),
    inputNormalization,
  );
}

describe('ReferenceProductResolver', () => {
  it('returns null when input.referenceProductId is unset', async () => {
    const repo = makeRepo();
    const resolver = makeResolver(repo);

    const result = await resolver.resolve(makeTestContext());
    expect(result).toBeNull();
    expect(repo.findByIdForPipeline).not.toHaveBeenCalled();
  });

  it('returns null and records phase error when repo throws', async () => {
    const repo = makeRepo({}, true);
    const resolver = makeResolver(repo);

    const context = makeTestContext({
      input: { referenceProductId: 'missing' },
    });
    const result = await resolver.resolve(context);

    expect(result).toBeNull();
    expect(context.errors[0].phase).toBe('reference_product');
  });

  it('returns null when referenceProductId does not resolve to a catalog product', async () => {
    const repo = makeRepo({});
    const resolver = makeResolver(repo);

    const context = makeTestContext({
      input: { referenceProductId: 'missing' },
    });
    const result = await resolver.resolve(context);

    expect(result).toBeNull();
  });

  it('classifies as resolved (same) and populates ctx.brand + ctx.category + ctx.referenceProduct', async () => {
    const reference = makeReferenceProduct();
    const repo = makeRepo({ 'ref-1': reference });
    const resolver = makeResolver(repo);

    const context = makeTestContext({ input: { referenceProductId: 'ref-1' } });
    const result = await resolver.resolve(context);

    expect(result).toEqual({
      kind: 'resolved',
      product: reference,
      confidence: 100,
      reason: 'reference_same',
    });
    expect(context.brand).toEqual({
      id: 'brand-1',
      name: 'Samsung',
      similarity: 1.0,
    });
    expect(context.category).toEqual({
      id: 'cat-monitors',
      name: 'Monitor',
      similarity: 1.0,
    });
    expect(context.referenceProduct?.productId).toBe('ref-1');
    expect(context.referenceProduct?.specs).toEqual({
      screenSize: '34"',
      panelType: 'OLED',
    });
  });

  it('classifies as variant when modelClues present and seeds effectiveMatchSpecs', async () => {
    const reference = makeReferenceProduct();
    const repo = makeRepo({ 'ref-1': reference });
    const resolver = makeResolver(repo);

    const context = makeTestContext({
      input: {
        referenceProductId: 'ref-1',
        modelClues: ['G85SD'],
      },
    });
    const result = await resolver.resolve(context);

    expect(result?.kind).toBe('reference_variant_search');
    // effectiveMatchSpecs inherits primary specs from the reference
    expect(context.effectiveMatchSpecs).toEqual({
      screenSize: '34"',
      panelType: 'OLED',
    });
    expect(context.brand?.id).toBe('brand-1');
    expect(context.category?.id).toBe('cat-monitors');
  });

  it('classifies as variant when input spec contradicts a primary spec', async () => {
    const reference = makeReferenceProduct();
    const repo = makeRepo({ 'ref-1': reference });
    const resolver = makeResolver(repo);

    const context = makeTestContext({
      input: {
        referenceProductId: 'ref-1',
        specs: [{ name: 'screenSize', value: '32"' }],
      },
    });
    const result = await resolver.resolve(context);

    expect(result?.kind).toBe('reference_variant_search');
    // input.specs override reference value via overlay semantics
    expect(context.effectiveMatchSpecs?.['screenSize']).toBe('32"');
    expect(context.effectiveMatchSpecs?.['panelType']).toBe('OLED');
  });
});

describe('buildReferenceVariantInput', () => {
  it('inherits brand + displayName + categoryHint from reference, uses first modelClue as model', () => {
    const reference = {
      brand: { name: 'Samsung' },
      model: 'S95D',
      displayName: 'Samsung S95D',
      productCategory: { name: 'Monitor' },
    } as unknown as ProductModel;

    const out = buildReferenceVariantInput(
      { modelClues: ['G85SD'], variantClues: ['full-size ports'] },
      reference,
    );
    expect(out.brand).toBe('Samsung');
    expect(out.model).toBe('G85SD');
    expect(out.referenceModel).toBe('S95D');
    expect(out.displayName).toBe('Samsung S95D G85SD');
    expect(out.categoryHint).toBe('Monitor');
    expect(out.variantClues).toEqual(['full-size ports']);
  });

  it('keeps original model when input model is non-empty', () => {
    const reference = {
      brand: { name: 'Samsung' },
      model: 'S95D',
    } as unknown as ProductModel;
    const out = buildReferenceVariantInput(
      { model: 'G80SD', modelClues: ['G85SD'] },
      reference,
    );
    expect(out.model).toBe('G80SD');
  });
});
