import type { ResolutionContext } from './resolution-context';
import { ResolutionStatus } from './resolution-status';

/**
 * Shape-contract smoke test for the v2 persisted context.
 *
 * Verifies the JSON round-trip we get when the context is written to / read
 * from the `ProductReference.searchContext` jsonb column. Everything must
 * survive `JSON.stringify` → `JSON.parse` except for the documented exception:
 * `input.searchBefore` is a `Date` on the way in but comes back as a string
 * (same behavior as the current jsonb column on TypeORM).
 */
describe('ResolutionContext shape', () => {
  function makeContext(): ResolutionContext {
    return {
      input: {
        brand: 'Samsung',
        model: 'G85SD',
        displayName: 'Samsung Odyssey OLED G8',
        categoryHint: 'monitor',
        category: { id: 'cat-monitors', name: 'Monitors' },
        specs: [{ name: 'screenSize', value: '34"' }],
        referenceProductId: '36d4064e-ac2d-44d0-8803-1829d08cd50a',
        referenceModel: 'Odyssey OLED G8 S34DG850SU',
        modelClues: ['G85SD'],
        variantClues: [],
        searchBefore: new Date('2025-11-11T10:53:43Z'),
        releaseYear: 2024,
        contentQuality: 'high',
      },
      options: {
        useEmbedding: true,
        webSearchEnabled: true,
        mode: 'loose',
      },
      referenceProduct: {
        productId: '36d4064e-ac2d-44d0-8803-1829d08cd50a',
        brand: 'Samsung',
        model: 'Odyssey OLED G8 S34DG850SU',
        productCategory: { id: 'cat-monitors', name: 'Monitors' },
        specs: { screenSize: 34, panelType: 'oled' },
      },
      effectiveMatchSpecs: { screenSize: 34, panelType: 'oled' },
      brand: { id: 'brand-samsung', name: 'Samsung', similarity: 1 },
      category: { id: 'cat-monitors', name: 'Monitors', similarity: 1 },
      modelVariants: [
        { model: 'G85SD', source: 'identification_clue' },
      ],
      searchedKeywords: ['samsung odyssey oled g8 monitor'],
      searchEvidence: [
        {
          title: 'Samsung Odyssey OLED G8',
          description: 'Review of the G85SD',
          url: 'https://example.com/g85sd',
          provider: 'dataforseo',
          queryIntent: 'reference_sibling_sku',
          modelNumbers: ['S34DG850SU'],
          resolvedProducts: [
            {
              brand: 'Samsung',
              model: 'Odyssey OLED G8 S34DG850SU',
              productId: '36d4064e-ac2d-44d0-8803-1829d08cd50a',
              specs: { screenSize: 34, panelType: 'oled' },
            },
          ],
        },
      ],
      recallFunnel: {
        fuzzyHits: 4,
        embeddingHits: 0,
        webHits: 1,
        afterDedupe: 4,
        afterReferenceExclusion: 3,
      },
      candidates: [
        {
          productId: 'candidate-1',
          brand: 'Samsung',
          model: 'S34BG850SU',
          source: 'fuzzy',
          matchScore: 71,
          matchComponents: {
            stringSimilarity: 0.87,
            tokenOverlap: 0.56,
            alphaMatch: 0.33,
            aliasMatch: false,
            specSimilarity: 0,
          },
        },
      ],
      strategiesRun: ['fuzzy', 'web'],
      webResearch: {
        queries: [
          {
            intent: 'reference_sibling_sku',
            keyword: '"Samsung Odyssey OLED G8 S34DG850SU" G85SD monitor',
            provider: 'dataforseo',
            cacheHit: true,
            serpResultCount: 16,
          },
        ],
        extractedModelNumbers: ['S34DG850SU', 'LS34DG850SUXEN'],
        webOnlyModels: ['LS34DG850SUXEN'],
      },
      filter: {
        qualifyingCandidateIds: ['candidate-1'],
        filteredCandidates: [],
      },
      scoring: {
        bestCandidate: { candidateId: 'candidate-1', alias: 'odyssey s34bg850su', score: 71 },
        secondScore: undefined,
        failedGates: ['low_confidence_anchored'],
        normalizedInput: 'odyssey oled g8s34dg850su',
      },
      decision: {
        kind: 'llm_unresolved',
        confidence: 0,
        reason: 'family_only_evidence',
        evidenceSummary: 'No candidate matches the G85SD model.',
        selectedCandidates: [],
      },
      status: ResolutionStatus.UNRESOLVED,
      totals: { durationMs: 7300, cost: 0.0042, llmCalls: 2, webSearchCalls: 1 },
      errors: [],
    };
  }

  it('round-trips through JSON without losing fields (except Date → string)', () => {
    const original = makeContext();
    const restored = JSON.parse(JSON.stringify(original)) as ResolutionContext;

    // Top-level keys preserved.
    expect(Object.keys(restored).sort()).toEqual(Object.keys(original).sort());

    // Spot-check every phase block round-trips.
    expect(restored.input.brand).toBe('Samsung');
    expect(restored.input.modelClues).toEqual(['G85SD']);
    expect(restored.options).toEqual(original.options);
    expect(restored.referenceProduct?.productId).toBe(original.referenceProduct?.productId);
    expect(restored.effectiveMatchSpecs).toEqual(original.effectiveMatchSpecs);
    expect(restored.brand?.similarity).toBe(1);
    expect(restored.category?.similarity).toBe(1);
    expect(restored.modelVariants).toEqual(original.modelVariants);
    expect(restored.searchedKeywords).toEqual(original.searchedKeywords);
    expect(restored.searchEvidence[0].modelNumbers).toEqual(['S34DG850SU']);
    expect(restored.recallFunnel?.afterReferenceExclusion).toBe(3);
    expect(restored.candidates[0].matchScore).toBe(71);
    expect(restored.candidates[0].matchComponents?.stringSimilarity).toBe(0.87);
    expect(restored.strategiesRun).toEqual(['fuzzy', 'web']);
    expect(restored.webResearch?.queries[0].cacheHit).toBe(true);
    expect(restored.webResearch?.webOnlyModels).toEqual(['LS34DG850SUXEN']);
    expect(restored.filter?.qualifyingCandidateIds).toEqual(['candidate-1']);
    expect(restored.scoring?.failedGates).toEqual(['low_confidence_anchored']);
    expect(restored.decision?.kind).toBe('llm_unresolved');
    expect(restored.decision?.confidence).toBe(0);
    expect(restored.status).toBe(ResolutionStatus.UNRESOLVED);
    expect(restored.totals.cost).toBe(0.0042);
    expect(restored.errors).toEqual([]);
  });

  it('serializes input.searchBefore as an ISO string (acknowledges the documented Date exception)', () => {
    const original = makeContext();
    const restored = JSON.parse(JSON.stringify(original)) as ResolutionContext;

    // Date does NOT survive JSON round-trip — it becomes a string. This is the
    // same behavior as the current production jsonb column on TypeORM.
    expect(typeof (restored.input.searchBefore as unknown)).toBe('string');
    expect(restored.input.searchBefore as unknown).toBe('2025-11-11T10:53:43.000Z');
  });

  it('uses a single 0–100 integer confidence scale on the decision', () => {
    const original = makeContext();
    expect(Number.isInteger(original.decision!.confidence)).toBe(true);
    expect(original.decision!.confidence).toBeGreaterThanOrEqual(0);
    expect(original.decision!.confidence).toBeLessThanOrEqual(100);
    expect(Number.isInteger(original.scoring!.bestCandidate!.score)).toBe(true);
    expect(original.candidates[0].matchScore).toBeGreaterThanOrEqual(0);
    expect(original.candidates[0].matchScore).toBeLessThanOrEqual(100);
  });
});
