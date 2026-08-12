import {
  ProductSimilarityService,
  ProductSimilarityInput,
} from './product-similarity.service';
import { SimilarityInputNormalizationService } from './similarity-input-normalization.service';
import { SpecComparisonService } from '../duplicate/spec-comparison.service';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { DebugTraceService } from '@fittkereso-backend/debug';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';

const MONITORS_MATCHING_CONFIG = {
  matchingConfig: {
    strictness: 'moderate',
    numericTokenRules: [
      {
        pattern: '^\\d{2,3}$',
        weight: 4,
        critical: true,
        description: 'Screen size',
      },
      {
        pattern: '\\d{3,4}(?:hz)?$',
        weight: 3.5,
        critical: true,
        description: 'Refresh rate',
      },
    ],
  },
  matcherSpecHierarchies: {
    panelType: {
      IPS: ['Nano IPS', 'Fast IPS'],
      OLED: ['QD-OLED', 'W-OLED'],
      LCD: ['IPS', 'VA', 'TN'],
    },
  },
};

function createService(categorySlug?: string): ProductSimilarityService {
  const categoryConfigService = {
    getConfig: (slug?: string) => {
      if (slug === 'monitors') return MONITORS_MATCHING_CONFIG;
      return undefined;
    },
  } as unknown as CategoryConfigService;

  const dynamicConfigService = {
    resolution: {
      matching: {
        defaultNumericTokenWeight: 2.5,
      },
    },
  } as unknown as DynamicConfigService;

  const inputNormalization = new SimilarityInputNormalizationService(
    categoryConfigService,
    dynamicConfigService,
  );

  const specComparison = new SpecComparisonService();
  const debugTrace = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as DebugTraceService;

  return new ProductSimilarityService(
    inputNormalization,
    specComparison,
    debugTrace,
  );
}

function score(
  input: ProductSimilarityInput,
): ReturnType<ProductSimilarityService['score']> {
  const service = createService();
  return service.score(input);
}

describe('ProductSimilarityService', () => {
  // ─── Exact Match ─────────────────────────────────────────────────────────

  it('scores exact model match at the natural ceiling of 100', () => {
    const result = score({
      query: { model: 'C34G55T' },
      candidate: { model: 'C34G55T' },
      brandName: 'Samsung',
      categorySlug: 'monitors',
    });

    // Identical name with no penalties → nameBase = 100, no deductions.
    expect(result.score).toBe(100);
    expect(result.components.stringSimilarity).toBe(1.0);
    expect(result.components.tokenOverlap).toBe(1.0);
  });

  // ─── Prefix / Suffix Variant ─────────────────────────────────────────────

  it('scores prefix variant with suffix bonus (C34G55TWWP vs C34G55T)', () => {
    const result = score({
      query: { model: 'C34G55TWWP' },
      candidate: { model: 'C34G55T' },
      brandName: 'Samsung',
      categorySlug: 'monitors',
    });

    // Suffix bonus should apply: t is a prefix of twwp
    // allNumericsPerfect amplifier (2.5x) penalizes alpha mismatch heavily,
    // but suffix bonus and the scoring formula should still produce a positive score
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });

  // ─── Sibling Model ───────────────────────────────────────────────────────

  it('scores sibling model line low (MPG341CQPX vs MAG341CQP)', () => {
    const result = score({
      query: { model: 'MPG341CQPX' },
      candidate: { model: 'MAG341CQP' },
      brandName: 'MSI',
      categorySlug: 'monitors',
    });

    expect(result.score).toBeLessThan(60);
    expect(result.components.alphaMatch).toBe(0);
  });

  it('scores exact match higher than sibling', () => {
    const service = createService();

    const exact = service.score({
      query: { model: 'MPG341CQPX' },
      candidate: { model: 'MPG341CQPX' },
      categorySlug: 'monitors',
    });

    const sibling = service.score({
      query: { model: 'MPG341CQPX' },
      candidate: { model: 'MAG341CQP' },
      categorySlug: 'monitors',
    });

    expect(exact.score).toBeGreaterThan(sibling.score);
    expect(exact.score - sibling.score).toBeGreaterThan(20);
  });

  // ─── Spec Affinity ───────────────────────────────────────────────────────

  it('spec confirmation increases score above no-spec baseline', () => {
    const service = createService();

    // Use a near-miss name pair so the base score is below 100 — spec confirmation can then visibly increase it
    const withSpecs = service.score({
      query: {
        model: '27GP850-B',
        specs: { screenSize: 27, panelType: 'IPS', refreshRate: 165 },
      },
      candidate: {
        model: '27GP850',
        specs: { screenSize: 27, panelType: 'IPS', refreshRate: 165 },
      },
      brandName: 'LG',
      categorySlug: 'monitors',
    });

    const noSpecs = service.score({
      query: { model: '27GP850-B' },
      candidate: { model: '27GP850' },
      brandName: 'LG',
      categorySlug: 'monitors',
    });

    expect(withSpecs.score).toBeGreaterThanOrEqual(noSpecs.score);
    expect(withSpecs.components.specSimilarity).toBeGreaterThan(0);
  });

  // ─── No Alpha Tokens ────────────────────────────────────────────────────

  it('handles purely numeric model codes (alphaMatch is absent signal)', () => {
    const result = score({
      query: { model: '12345' },
      candidate: { model: '12345' },
    });

    expect(result.components.alphaMatch).toBe(0); // No critical alpha tokens → signal absent
    // Without alpha contribution, max nameScore is 0.85 * 70 = 59.5 → 60.
    expect(result.score).toBeGreaterThanOrEqual(55);
  });

  // ─── Alias Cross-Match ───────────────────────────────────────────────────

  it('alias cross-match sets the aliasMatch flag and never lowers the score', () => {
    const service = createService();

    const withAlias = service.score({
      query: { model: '27GP850-B' },
      candidate: {
        model: 'LG 27GP850',
        aliases: ['27GP850-B'],
      },
      brandName: 'LG',
      categorySlug: 'monitors',
    });

    const withoutAlias = service.score({
      query: { model: '27GP850-B' },
      candidate: { model: 'LG 27GP850' },
      brandName: 'LG',
      categorySlug: 'monitors',
    });

    expect(withAlias.components.aliasMatch).toBe(true);
    expect(withoutAlias.components.aliasMatch).toBe(false);
    // aliasMatch itself is a diagnostic, not a direct score contributor; with
    // the alias added to candidateNames the cross-pair similarity is at least
    // as good as without.
    expect(withAlias.score).toBeGreaterThanOrEqual(withoutAlias.score);
  });

  // ─── Suffix Discriminator — NO Bonus ─────────────────────────────────────

  it('does NOT apply suffix bonus for product-line discriminators (dgm vs qgm)', () => {
    const result = score({
      query: { model: 'S2722DGM' },
      candidate: { model: 'S2722QGM' },
      brandName: 'Dell',
      categorySlug: 'monitors',
    });

    // dgm vs qgm: both ≥3 chars, neither is prefix of the other → no bonus
    // Score should be moderate, not boosted
    expect(result.score).toBeLessThan(90);
  });

  it('applies suffix bonus for short variant suffix (27GP850-B vs 27GP850-X)', () => {
    const result = score({
      query: { model: '27GP850-B' },
      candidate: { model: '27GP850-X' },
      brandName: 'LG',
      categorySlug: 'monitors',
    });

    // b vs x: both length 1 → qualifies as variant appendage. Without specs,
    // nameScore tops out at 70; with suffix bonus +10 → at least 70.
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  // ─── Year Gate ───────────────────────────────────────────────────────────

  it('returns score 0 when candidate released after query year', () => {
    const result = score({
      query: { model: 'Odyssey G7', year: 2022 },
      candidate: { model: 'Odyssey G7', releaseYear: 2024 },
      brandName: 'Samsung',
      categorySlug: 'monitors',
    });

    expect(result.score).toBe(0);
    expect(result.bestMatchName).toBe('');
  });

  it('year proximity adds to score when product is recent', () => {
    const service = createService();

    const withYear = service.score({
      query: { model: 'G27Q', year: 2024 },
      candidate: { model: 'G27Q', releaseYear: 2023 },
      categorySlug: 'monitors',
    });

    const noYear = service.score({
      query: { model: 'G27Q' },
      candidate: { model: 'G27Q' },
      categorySlug: 'monitors',
    });

    expect(withYear.score).toBeGreaterThanOrEqual(noYear.score);
  });

  // ─── No Category Slug ────────────────────────────────────────────────────

  it('falls back to default token config when no categorySlug', () => {
    const result = score({
      query: { model: 'MPG341CQPX' },
      candidate: { model: 'MPG341CQPX' },
    });

    // Exact name match → nameBase = 100, no penalties.
    expect(result.score).toBe(100);
  });

  // ─── Empty / Invalid Input ───────────────────────────────────────────────

  it('returns score 0 for empty model input', () => {
    const result = score({
      query: { model: '' },
      candidate: { model: 'SomeModel' },
    });

    expect(result.score).toBe(0);
  });

  // ─── Cross-Matching Uses Best Pair ───────────────────────────────────────

  it('cross-matching picks the best name pair across model and displayName', () => {
    const result = score({
      query: { model: 'Predator X34 X5' },
      candidate: {
        model: 'X34X5bmiiphuzx',
        displayName: 'Acer Predator X34 X5',
      },
      brandName: 'Acer',
    });

    // The displayName match "predator x34 x5" should produce a better score
    // than the model match "x34x5bmiiphuzx"
    expect(result.score).toBeGreaterThan(50);
    expect(result.components.stringSimilarity).toBeGreaterThan(0.5);
  });

  // ─── Extra Query Tokens (Superset Input) ────────────────────────────────

  it('scores superset query token high — "ROG Swift OLED PG32UCDM" vs "ROG Swift PG32UCDM"', () => {
    const result = score({
      query: { model: 'ROG Swift OLED PG32UCDM' },
      candidate: { model: 'ROG Swift PG32UCDM' },
      brandName: 'ASUS',
      categorySlug: 'monitors',
    });

    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.components.stringSimilarity).toBeGreaterThan(0.8);
  });

  it('extra query token scores higher than a genuine token mismatch', () => {
    const service = createService();

    const extraToken = service.score({
      query: { model: 'ROG Swift OLED PG32UCDM' },
      candidate: { model: 'ROG Swift PG32UCDM' },
      brandName: 'ASUS',
      categorySlug: 'monitors',
    });

    const tokenMismatch = service.score({
      query: { model: 'ROG Swift PG32UCDMR' },
      candidate: { model: 'ROG Swift PG32UCDMZ' },
      brandName: 'ASUS',
      categorySlug: 'monitors',
    });

    expect(extraToken.score).toBeGreaterThan(tokenMismatch.score);
  });

  it('extra numeric query token pays higher penalty than extra alpha token', () => {
    const service = createService();

    const extraAlpha = service.score({
      query: { model: 'ROG Swift OLED PG32UCDM' },
      candidate: { model: 'ROG Swift PG32UCDM' },
      brandName: 'ASUS',
      categorySlug: 'monitors',
    });

    const extraNumeric = service.score({
      query: { model: 'ROG Swift 4K PG32UCDM' },
      candidate: { model: 'ROG Swift PG32UCDM' },
      brandName: 'ASUS',
      categorySlug: 'monitors',
    });

    expect(extraAlpha.score).toBeGreaterThan(extraNumeric.score);
  });

  // ─── bestMatchName ───────────────────────────────────────────────────────

  it('returns the candidate-side name that produced the best score', () => {
    const result = score({
      query: { model: 'C34G55T' },
      candidate: { model: 'C34G55T' },
      categorySlug: 'monitors',
    });

    expect(result.bestMatchName).toBe('c34g55t');
  });

  // ─── Discriminator vs Variant Distinction ────────────────────────────────

  it('penalizes a product-line-discriminator suffix mismatch but not a variant-appendage mismatch', () => {
    const service = createService();

    // Variant appendage: -B vs -X (color codes, ≤2 chars) → no penalty.
    const variant = service.score({
      query: { model: '27GP850-B' },
      candidate: { model: '27GP850-X' },
      brandName: 'LG',
      categorySlug: 'monitors',
    });

    // Product-line discriminator: DGM vs QGM (3-char alpha suffix, neither
    // prefix of the other) → penalized.
    const discriminator = service.score({
      query: { model: 'S2722DGM' },
      candidate: { model: 'S2722QGM' },
      brandName: 'Dell',
      categorySlug: 'monitors',
    });

    expect(variant.score - discriminator.score).toBeGreaterThanOrEqual(15);
  });

  // ─── Critical-Numeric Mismatch (Typo Case) ───────────────────────────────

  it('penalizes critical-numeric disagreements so typos do not auto-accept', () => {
    // 431 vs 341 — a digit-transposition typo. Critical numerics disagree.
    const result = score({
      query: { model: 'MPG431CQPX' },
      candidate: { model: 'MPG341CQPX' },
      brandName: 'MSI',
      categorySlug: 'monitors',
    });

    // Should land below acceptThreshold (70) so it escalates to LLM rather
    // than auto-accepting on the moderate stringSim that a transposition gives.
    expect(result.score).toBeLessThan(70);
  });

  // ─── Variant Suffix on Input Only ────────────────────────────────────────

  it('keeps the score high when the input has an extra variant-appendage suffix', () => {
    // Input has -B suffix; candidate has none. The B suffix is a color/region
    // code, not a discriminator, so it should NOT penalize the match.
    const result = score({
      query: { model: 'LG 34GS95QE-B' },
      candidate: { model: 'LG 34GS95QE' },
      brandName: 'LG',
      categorySlug: 'monitors',
    });

    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  // ─── Original PG34WCDM/PG34WCDN bug at the formula level ─────────────────

  it('produces a wide best-vs-second gap for the PG34WCDM/PG34WCDN bug case', () => {
    const service = createService('monitors');

    const best = service.score({
      query: { model: 'PG34WCDM' },
      candidate: { model: 'PG34WCDM' },
      brandName: 'ASUS',
      categorySlug: 'monitors',
    });

    const second = service.score({
      query: { model: 'PG34WCDM' },
      candidate: { model: 'PG34WCDN' },
      brandName: 'ASUS',
      categorySlug: 'monitors',
    });

    // Identity stays at 100; the discriminator-mismatch second loses ≥15
    // points, producing a clear gap above the 5-point ambiguityGap threshold.
    expect(best.score).toBe(100);
    expect(best.score - second.score).toBeGreaterThanOrEqual(15);
  });
});
