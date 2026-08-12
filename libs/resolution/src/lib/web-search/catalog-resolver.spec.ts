import type { CategoryConfigService } from '@fittkereso-backend/config';
import { CatalogResolver } from './catalog-resolver';
import { InputNormalizationService } from '../matching/input-normalization.service';
import {
  MatchingConfig,
  MatchingConfigService,
} from '../matching/matching-config.service';
import type {
  ModelCatalogSearchArgs,
  ModelCatalogSearchResult,
} from '../strategies/recall/model-catalog-search.service';
import { ModelCatalogSearchService } from '../strategies/recall/model-catalog-search.service';
import { makeTestContext } from '../testing/make-context';
import type { SearchEvidence } from '../models/search-evidence';
import type { SlimCandidate } from '../models/slim-types';

const MATCHING_CONFIG: MatchingConfig = {
  acceptThreshold: 55,
  acceptThresholdStrict: 70,
  ambiguityGap: 5,
  defaultStrictness: 'moderate',
  defaultNumericTokenWeight: 2.5,
  ambiguityGapAnchored: 10,
};

function makeSlim(
  productId: string,
  source: SlimCandidate['source'] = 'fuzzy',
  overrides: Partial<SlimCandidate> = {},
): SlimCandidate {
  return {
    productId,
    brand: 'Samsung',
    model: 'G85SD',
    productCategory: { id: 'c-monitors', name: 'Monitor', slug: 'monitors' },
    specs: { screenSize: '34"' },
    aliases: [],
    source,
    ...overrides,
  };
}

function makeEvidence(modelNumbers: string[]): SearchEvidence {
  return {
    title: 't',
    description: 'd',
    url: `https://example.com/${modelNumbers.join('-')}`,
    provider: 'dataforseo',
    queryIntent: 'model_with_specs',
    modelNumbers,
    resolvedProducts: [],
  };
}

interface SearchStub {
  service: ModelCatalogSearchService;
  search: jest.Mock<
    Promise<ModelCatalogSearchResult>,
    [ModelCatalogSearchArgs]
  >;
}

function makeSearchStub(
  impl: (args: ModelCatalogSearchArgs) => Promise<ModelCatalogSearchResult>,
): SearchStub {
  const search = jest.fn(impl);
  return {
    service: { search } as unknown as ModelCatalogSearchService,
    search,
  };
}

describe('CatalogResolver', () => {
  let inputNormalization: InputNormalizationService;

  beforeEach(() => {
    inputNormalization = new InputNormalizationService(
      { config: MATCHING_CONFIG } as unknown as MatchingConfigService,
      { getConfig: () => undefined } as unknown as CategoryConfigService,
    );
  });

  it('returns empty when no model numbers were extracted', async () => {
    const stub = makeSearchStub(async () => ({
      candidates: [],
      source: 'none',
    }));
    const resolver = new CatalogResolver(stub.service, inputNormalization);

    const result = await resolver.resolve(makeTestContext(), [
      makeEvidence([]),
    ]);

    expect(result.addedCandidates).toHaveLength(0);
    expect(result.webOnlyModels).toHaveLength(0);
    expect(stub.search).not.toHaveBeenCalled();
  });

  it('resolves SKUs to SlimCandidates with source=web', async () => {
    const stub = makeSearchStub(async () => ({
      candidates: [makeSlim('p1', 'fuzzy')],
      source: 'fuzzy',
    }));
    const resolver = new CatalogResolver(stub.service, inputNormalization);

    const evidence = [makeEvidence(['G85SD'])];
    const result = await resolver.resolve(
      makeTestContext({ input: { brand: 'Samsung' } }),
      evidence,
    );

    expect(result.addedCandidates).toHaveLength(1);
    expect(result.addedCandidates[0].productId).toBe('p1');
    expect(result.addedCandidates[0].source).toBe('web');
    expect(evidence[0].resolvedProducts).toHaveLength(1);
    expect(evidence[0].resolvedProducts[0].productId).toBe('p1');
  });

  it('falls back to embedding hits when fuzzy returned none', async () => {
    const stub = makeSearchStub(async () => ({
      candidates: [makeSlim('p2', 'embedding', { model: 'OK_SKU' })],
      source: 'embedding',
    }));
    const resolver = new CatalogResolver(stub.service, inputNormalization);

    const result = await resolver.resolve(
      makeTestContext({
        options: { useEmbedding: true, webSearchEnabled: false, mode: 'loose' },
      }),
      [makeEvidence(['OK_SKU'])],
    );

    expect(result.addedCandidates).toHaveLength(1);
    expect(result.addedCandidates[0].productId).toBe('p2');
    expect(result.addedCandidates[0].source).toBe('web');
    expect(stub.search).toHaveBeenCalledWith(
      expect.objectContaining({ modelString: 'OK_SKU', useEmbedding: true }),
    );
  });

  it('passes useEmbedding=false through to the search service', async () => {
    const stub = makeSearchStub(async () => ({
      candidates: [],
      source: 'none',
    }));
    const resolver = new CatalogResolver(stub.service, inputNormalization);

    await resolver.resolve(
      makeTestContext({
        options: {
          useEmbedding: false,
          webSearchEnabled: false,
          mode: 'loose',
        },
      }),
      [makeEvidence(['G85SD'])],
    );

    expect(stub.search).toHaveBeenCalledWith(
      expect.objectContaining({ useEmbedding: false }),
    );
  });

  it('records unresolved SKUs as webOnlyModels', async () => {
    const stub = makeSearchStub(async () => ({
      candidates: [],
      source: 'none',
    }));
    const resolver = new CatalogResolver(stub.service, inputNormalization);

    const result = await resolver.resolve(makeTestContext(), [
      makeEvidence(['UNKNOWN_SKU']),
    ]);

    expect(result.addedCandidates).toEqual([]);
    expect(result.webOnlyModels).toEqual(['UNKNOWN_SKU']);
  });

  it('dedupes resolved products across records that share an SKU', async () => {
    const stub = makeSearchStub(async () => ({
      candidates: [makeSlim('p1', 'fuzzy')],
      source: 'fuzzy',
    }));
    const resolver = new CatalogResolver(stub.service, inputNormalization);

    const evidence = [makeEvidence(['G85SD']), makeEvidence(['G85SD'])];
    const result = await resolver.resolve(makeTestContext(), evidence);

    expect(result.addedCandidates).toHaveLength(1);
    expect(stub.search).toHaveBeenCalledTimes(1);
  });

  it('records failures as webOnlyModels and continues', async () => {
    const stub = makeSearchStub(async (args) => {
      if (args.modelString === 'BROKEN_SKU') throw new Error('db');
      return {
        candidates: [makeSlim('p2', 'fuzzy', { model: 'OK_SKU' })],
        source: 'fuzzy',
      };
    });
    const resolver = new CatalogResolver(stub.service, inputNormalization);

    const result = await resolver.resolve(makeTestContext(), [
      makeEvidence(['BROKEN_SKU', 'OK_SKU']),
    ]);

    expect(result.webOnlyModels).toEqual(['BROKEN_SKU']);
    expect(result.addedCandidates.map((c) => c.productId)).toEqual(['p2']);
  });

  it('forwards ctx.category and ctx.options to the search service', async () => {
    const stub = makeSearchStub(async () => ({
      candidates: [],
      source: 'none',
    }));
    const resolver = new CatalogResolver(stub.service, inputNormalization);

    await resolver.resolve(
      makeTestContext({
        category: { id: 'cat-monitors', name: 'Monitor', similarity: 1.0 },
      }),
      [makeEvidence(['G85SD'])],
    );

    const args = stub.search.mock.calls[0][0];
    expect(args.context.category?.id).toBe('cat-monitors');
    expect(args.modelString).toBe('G85SD');
  });
});
