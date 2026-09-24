import type {
  ProductCategoryConfig,
  ProductModel,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { primarySpecMismatches } from './gates';
import {
  KeyMatch,
  ProductKeyLookupService,
} from './product-key-lookup.service';

// As the real ebikes config: years and capacities must match exactly.
const ebikes: ProductCategoryConfig = {
  primarySpecs: ['modelYear', 'batteryCapacity'],
  matcherSpecs: ['weight'],
  matchingConfig: {
    specTolerances: {
      modelYear: { absolute: 0 },
      batteryCapacity: { absolute: 0 },
    },
  },
};

describe('ProductKeyLookupService', () => {
  let service: ProductKeyLookupService;
  let offerRepo: {
    find: jest.Mock;
    findModelIdsByGtins: jest.Mock;
    findModelIdsByMpns: jest.Mock;
  };
  let sourceRecordRepo: {
    findModelIdsBySourceAndExternalIds: jest.Mock;
    findDeclaredSiblingIdsOfModel: jest.Mock;
  };
  let productRepo: { find: jest.Mock };
  let pairRepo: { upsertPairs: jest.Mock };

  /** Stored products the lookup can land on: id -> brand and specs. */
  const givenProducts = (
    products: Record<string, { brandId: string; specs?: ProductSpecs }>,
  ) =>
    productRepo.find.mockResolvedValue(
      Object.entries(products).map(([id, { brandId, specs }]) => ({
        id,
        specs,
        brand: { id: brandId },
      })),
    );

  const listing = (specs?: ProductSpecs, brandId: string | null = 'ktm') => ({
    brandId: brandId ?? undefined,
    specs,
    categorySlug: 'ebikes',
  });

  const match = (via: KeyMatch['via'], productId: string, key = 'k'): KeyMatch => ({
    via,
    key,
    productId,
  });

  beforeEach(() => {
    offerRepo = {
      find: jest.fn().mockResolvedValue([]),
      findModelIdsByGtins: jest.fn().mockResolvedValue([]),
      findModelIdsByMpns: jest.fn().mockResolvedValue([]),
    };
    sourceRecordRepo = {
      findModelIdsBySourceAndExternalIds: jest.fn().mockResolvedValue([]),
      findDeclaredSiblingIdsOfModel: jest.fn().mockResolvedValue([]),
    };
    productRepo = { find: jest.fn().mockResolvedValue([]) };
    pairRepo = { upsertPairs: jest.fn().mockImplementation(async (rows) => rows.length) };

    service = new ProductKeyLookupService(
      offerRepo as never,
      sourceRecordRepo as never,
      productRepo as never,
      pairRepo as never,
      { getConfig: jest.fn().mockReturnValue(ebikes) } as never,
    );
  });

  describe('lookup', () => {
    const identifiers = {
      sourceId: 'ebikeshop',
      siblingIds: ['1260040103', '1260040113'],
      gtins: ['09008594503199', '09008594503199'],
      mpns: ['1260040108'],
      brandId: 'ktm',
    };

    it('asks each tier with its own identifiers, deduplicated', async () => {
      await service.lookup(identifiers);

      expect(sourceRecordRepo.findModelIdsBySourceAndExternalIds).toHaveBeenCalledWith(
        'ebikeshop',
        ['1260040103', '1260040113'],
      );
      expect(offerRepo.findModelIdsByGtins).toHaveBeenCalledWith(['09008594503199']);
      expect(offerRepo.findModelIdsByMpns).toHaveBeenCalledWith('ktm', ['1260040108']);
    });

    // An article number is only unique inside its manufacturer's numbering.
    it('does not look MPNs up without a resolved brand', async () => {
      await service.lookup({ ...identifiers, brandId: undefined });

      expect(offerRepo.findModelIdsByMpns).not.toHaveBeenCalled();
    });

    it('returns every product found, in tier order, once per tier', async () => {
      sourceRecordRepo.findModelIdsBySourceAndExternalIds.mockResolvedValue([
        { modelId: 'p1', externalId: '1260040103' },
        { modelId: 'p1', externalId: '1260040113' },
      ]);
      offerRepo.findModelIdsByGtins.mockResolvedValue([
        { modelId: 'p2', gtin: '09008594503199' },
      ]);
      offerRepo.findModelIdsByMpns.mockResolvedValue([{ modelId: 'p1', mpn: '1260040108' }]);

      expect(await service.lookup(identifiers)).toEqual([
        { via: 'sibling', key: '1260040103', productId: 'p1' },
        { via: 'gtin', key: '09008594503199', productId: 'p2' },
        { via: 'mpn', key: '1260040108', productId: 'p1' },
      ]);
    });
  });

  describe('decide', () => {
    it('finds nothing to decide when no identifier matched', async () => {
      const decision = await service.decide([], listing());

      expect(decision.verdict).toEqual({ kind: 'none' });
      expect(productRepo.find).not.toHaveBeenCalled();
    });

    it('attaches to the one product a tier found, when brand and primary specs agree', async () => {
      givenProducts({ p1: { brandId: 'ktm', specs: { modelYear: 2026, weight: 24 } } });

      const decision = await service.decide(
        [match('gtin', 'p1')],
        // A matcher spec may differ — one shop rounds its weights.
        listing({ modelYear: 2026, weight: 23.8 }),
      );

      expect(decision.verdict).toEqual({ kind: 'attach', via: 'gtin', productId: 'p1' });
    });

    it('calls a tier that found several products a conflict', async () => {
      givenProducts({ p1: { brandId: 'ktm' }, p2: { brandId: 'ktm' } });

      const decision = await service.decide(
        [match('gtin', 'p1'), match('gtin', 'p2')],
        listing(),
      );

      expect(decision.verdict).toEqual({
        kind: 'conflict',
        via: 'gtin',
        reason: 'ambiguous',
        productIds: ['p1', 'p2'],
      });
    });

    it('refuses a product of another brand', async () => {
      givenProducts({ p1: { brandId: 'cube' } });

      const decision = await service.decide([match('mpn', 'p1')], listing());

      expect(decision.verdict).toMatchObject({ kind: 'conflict', reason: 'brand_mismatch' });
    });

    it('refuses when the listing\'s brand did not resolve, as there is nothing to compare', async () => {
      givenProducts({ p1: { brandId: 'ktm' } });

      const decision = await service.decide([match('gtin', 'p1')], listing({}, null));

      expect(decision.verdict).toMatchObject({ kind: 'conflict', reason: 'brand_mismatch' });
    });

    // speedbike lists one CUBE trike twice under a single GTIN, as 2025 and as
    // 2027 — the identifier alone would merge two model years.
    it('refuses a product a primary spec contradicts, and keeps the contradiction for the pair', async () => {
      givenProducts({ p1: { brandId: 'ktm', specs: { modelYear: 2025 } } });

      const decision = await service.decide(
        [match('gtin', 'p1')],
        listing({ modelYear: 2027 }),
      );

      expect(decision.verdict).toMatchObject({ kind: 'conflict', reason: 'spec_mismatch' });
      expect(decision.failedGates['p1']).toEqual([
        expect.objectContaining({ spec: 'modelYear', queryValue: 2027, candidateValue: 2025 }),
      ]);
    });

    it('lets the first tier that found anything decide, even when a later one is clean', async () => {
      givenProducts({ p1: { brandId: 'ktm' }, p2: { brandId: 'ktm' }, p3: { brandId: 'ktm' } });

      const decision = await service.decide(
        [match('sibling', 'p1'), match('sibling', 'p2'), match('gtin', 'p3')],
        listing(),
      );

      expect(decision.verdict).toMatchObject({ kind: 'conflict', via: 'sibling' });
    });

    it('decides by tier order, not by the order matches arrive in', async () => {
      givenProducts({ p1: { brandId: 'ktm' }, p2: { brandId: 'ktm' } });

      const decision = await service.decide(
        [match('mpn', 'p2'), match('sibling', 'p1')],
        listing(),
      );

      expect(decision.verdict).toEqual({ kind: 'attach', via: 'sibling', productId: 'p1' });
    });
  });

  describe('disagreeingTiers', () => {
    const matches = [match('sibling', 'p1'), match('gtin', 'p2'), match('mpn', 'p1')];

    it('reports every tier pointing elsewhere when the listing\'s history resolved it', () => {
      expect(service.disagreeingTiers(matches, 'p1')).toEqual(['gtin']);
      expect(service.disagreeingTiers(matches, 'p9')).toEqual(['sibling', 'gtin', 'mpn']);
    });

    it('only reports tiers after the one that resolved it', () => {
      expect(service.disagreeingTiers(matches, 'p2', 'gtin')).toEqual(['mpn']);
    });
  });

  describe('recordPairs', () => {
    it('pairs the listing\'s product with every other product its identifiers point at', async () => {
      const gates = {
        'b-product': primarySpecMismatches({
          querySpecs: { modelYear: 2027 },
          candidateSpecs: { modelYear: 2025 },
          categoryConfig: ebikes,
        }),
      };

      const written = await service.recordPairs(
        'a-product',
        [match('gtin', 'b-product', '04054571447913'), match('mpn', 'a-product')],
        gates,
        'scrape',
      );

      expect(written).toBe(1);
      expect(pairRepo.upsertPairs).toHaveBeenCalledWith([
        {
          productAId: 'a-product',
          productBId: 'b-product',
          similarityScore: 100,
          matchedOn: 'gtin',
          matchedValue: '04054571447913',
          failedGates: [
            expect.objectContaining({
              spec: 'modelYear',
              productAValue: 2027,
              productBValue: 2025,
            }),
          ],
          nameSimilarity: null,
          detectedBy: 'scrape',
        },
      ]);
    });

    it('orders a pair A < B, moving the listing\'s values to its product\'s side', async () => {
      const gates = {
        'a-other': primarySpecMismatches({
          querySpecs: { modelYear: 2027 },
          candidateSpecs: { modelYear: 2025 },
          categoryConfig: ebikes,
        }),
      };

      await service.recordPairs('z-product', [match('gtin', 'a-other')], gates, 'scrape');

      expect(pairRepo.upsertPairs).toHaveBeenCalledWith([
        expect.objectContaining({
          productAId: 'a-other',
          productBId: 'z-product',
          failedGates: [
            expect.objectContaining({ productAValue: 2025, productBValue: 2027 }),
          ],
        }),
      ]);
    });

    it('shows the strongest evidence once per product: the earliest tier', async () => {
      await service.recordPairs(
        'a-product',
        [match('sibling', 'b-product', '1260040103'), match('gtin', 'b-product')],
        {},
        'scrape',
      );

      expect(pairRepo.upsertPairs).toHaveBeenCalledWith([
        expect.objectContaining({ matchedOn: 'sibling', matchedValue: '1260040103' }),
      ]);
    });

    it('writes nothing when every identifier points at the listing\'s own product', async () => {
      expect(
        await service.recordPairs('a-product', [match('gtin', 'a-product')], {}, 'scrape'),
      ).toBe(0);
      expect(pairRepo.upsertPairs).not.toHaveBeenCalled();
    });
  });

  // What the nightly scan re-finds, so the pairs an import raised survive it.
  describe('storedPairRows', () => {
    const product = {
      id: 'a-product',
      specs: { modelYear: 2027 },
      brand: { id: 'ktm' },
      productCategory: { slug: 'ebikes' },
    } as unknown as ProductModel;

    beforeEach(() => {
      offerRepo.find.mockResolvedValue([
        { id: 'o1', gtin: '04054571447913', mpn: '1260040108' },
        { id: 'o2', gtin: null, mpn: null },
      ]);
      sourceRecordRepo.findDeclaredSiblingIdsOfModel.mockResolvedValue([
        { sourceId: 'ebikeshop', siblingIds: ['1260040103', '1260040108'] },
      ]);
    });

    it('looks up what this product\'s offers and listings carry', async () => {
      await service.storedPairRows(product, 'scan');

      expect(offerRepo.findModelIdsByGtins).toHaveBeenCalledWith(['04054571447913']);
      expect(offerRepo.findModelIdsByMpns).toHaveBeenCalledWith('ktm', ['1260040108']);
      expect(sourceRecordRepo.findModelIdsBySourceAndExternalIds).toHaveBeenCalledWith(
        'ebikeshop',
        ['1260040103', '1260040108'],
      );
    });

    it('pairs every other product sharing one, with the stored specs\' contradictions', async () => {
      // Its own sizes and its own offers point back at itself.
      sourceRecordRepo.findModelIdsBySourceAndExternalIds.mockResolvedValue([
        { modelId: 'a-product', externalId: '1260040108' },
        { modelId: 'c-product', externalId: '1260040103' },
      ]);
      offerRepo.findModelIdsByGtins.mockResolvedValue([
        { modelId: 'a-product', gtin: '04054571447913' },
        { modelId: 'b-product', gtin: '04054571447913' },
      ]);
      productRepo.find.mockResolvedValue([
        { id: 'b-product', specs: { modelYear: 2025 } },
        { id: 'c-product', specs: { modelYear: 2027 } },
      ]);

      const rows = await service.storedPairRows(product, 'scan');

      expect(rows).toEqual([
        expect.objectContaining({
          productAId: 'a-product',
          productBId: 'c-product',
          matchedOn: 'sibling',
          matchedValue: '1260040103',
          similarityScore: 100,
          failedGates: [],
          detectedBy: 'scan',
        }),
        expect.objectContaining({
          productAId: 'a-product',
          productBId: 'b-product',
          matchedOn: 'gtin',
          failedGates: [
            expect.objectContaining({
              spec: 'modelYear',
              productAValue: 2027,
              productBValue: 2025,
            }),
          ],
        }),
      ]);
      expect(pairRepo.upsertPairs).not.toHaveBeenCalled();
    });

    it('does not look MPNs up for a product without a brand', async () => {
      await service.storedPairRows(
        { ...product, brand: undefined } as unknown as ProductModel,
        'scan',
      );

      expect(offerRepo.findModelIdsByMpns).not.toHaveBeenCalled();
    });

    it('loads nothing more when no other product shares an identifier', async () => {
      offerRepo.findModelIdsByGtins.mockResolvedValue([
        { modelId: 'a-product', gtin: '04054571447913' },
      ]);

      expect(await service.storedPairRows(product, 'scan')).toEqual([]);
      expect(productRepo.find).not.toHaveBeenCalled();
    });
  });
});
