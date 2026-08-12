import { ProductCategory } from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import {
  MatchingConfigService,
  MatchingConfig,
} from './matching-config.service';
import {
  InputNormalizationService,
  CategoryMatchConfig,
} from './input-normalization.service';

const MOCK_MATCHING_CONFIG: MatchingConfig = {
  acceptThreshold: 55,
  acceptThresholdStrict: 70,
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
    {
      pattern: /\d{3,4}(?:hz)?$/i,
      weight: 3.5,
      description: 'Refresh rate',
      critical: true,
    },
  ],
};

function makeMatchingConfigService(): MatchingConfigService {
  return { config: MOCK_MATCHING_CONFIG } as unknown as MatchingConfigService;
}

function makeCategoryConfigService(
  configs: Record<string, { matchingConfig?: any }> = {},
): CategoryConfigService {
  return {
    getConfig: (slug: string) => configs[slug],
  } as unknown as CategoryConfigService;
}

describe('InputNormalizationService', () => {
  let service: InputNormalizationService;

  beforeEach(() => {
    service = new InputNormalizationService(
      makeMatchingConfigService(),
      makeCategoryConfigService(),
    );
  });

  // ─── basicNormalization ─────────────────────────────────────────────────────

  describe('basicNormalization', () => {
    it('collapses space between letter and digit', () => {
      expect(service.basicNormalization('MPG 341CQPX')).toBe('mpg341cqpx');
    });

    it('collapses space between digit and letter', () => {
      expect(service.basicNormalization('34 GS95QE')).toBe('34gs95qe');
    });

    it('lowercases the string', () => {
      expect(service.basicNormalization('MPG341CQPX')).toBe('mpg341cqpx');
    });

    it('preserves hyphens', () => {
      expect(service.basicNormalization('34GS95QE-B')).toBe('34gs95qe-b');
    });

    it('removes special chars (replaces with space, then collapses digit-alpha boundary)', () => {
      // (AQ) → " aq ", then digit-space-alpha "7 a" collapses to "7a"
      expect(service.basicNormalization('PG27(AQ)DN')).toBe('pg27aq dn');
    });

    it('collapses multiple spaces', () => {
      expect(service.basicNormalization('  ASUS  ROG  ')).toBe('asus rog');
    });

    it('handles empty string', () => {
      expect(service.basicNormalization('')).toBe('');
    });
  });

  // ─── normalizeForMatching ───────────────────────────────────────────────────

  describe('normalizeForMatching', () => {
    it('picks displayName when longer after brand removal', () => {
      const result = service.normalizeForMatching(
        {
          model: 'MPG341CQPX',
          displayName: 'MSI Optix MPG341CQPX',
          brand: 'MSI',
        },
        MONITORS_CONFIG,
      );
      expect(result).toBe('optix mpg341cqpx');
    });

    it('picks model when displayName strips to empty', () => {
      const result = service.normalizeForMatching(
        { model: '34GS95QE-B', displayName: 'LG', brand: 'LG' },
        MONITORS_CONFIG,
      );
      expect(result).toBe('34gs95qe-b');
    });

    it('returns empty string when both inputs are empty', () => {
      const result = service.normalizeForMatching({}, MONITORS_CONFIG);
      expect(result).toBe('');
    });

    it('strips brand prefix from model', () => {
      const result = service.normalizeForMatching(
        { model: 'LG 34GS95QE', brand: 'LG' },
        MONITORS_CONFIG,
      );
      expect(result).toBe('34gs95qe');
    });
  });

  // ─── parseModelCode ─────────────────────────────────────────────────────────

  describe('parseModelCode', () => {
    it('parses model code into words', () => {
      const result = service.parseModelCode('mpg341cqpx', MONITORS_CONFIG);
      expect(result.valid).toBe(true);
      expect(result.words).toEqual(['mpg', '341', 'cqpx']);
    });

    it('identifies critical numeric tokens (2-3 digit rule)', () => {
      const result = service.parseModelCode('34gs95qe', MONITORS_CONFIG);
      expect(result.criticalNumericTokens).toContain('34');
      expect(result.criticalNumericTokens).toContain('95');
    });

    it('identifies critical alpha tokens (alpha before digit)', () => {
      const result = service.parseModelCode('mpg341cqpx', MONITORS_CONFIG);
      expect(result.criticalAlphaTokens).toContain('mpg');
    });

    it('does not mark alpha token as critical when not followed by digit', () => {
      const result = service.parseModelCode('asus rog', MONITORS_CONFIG);
      expect(result.criticalAlphaTokens).toEqual([]);
    });

    it('identifies suffix alpha tokens (alpha after first numeric token)', () => {
      const result = service.parseModelCode('mag341cqp', MONITORS_CONFIG);
      expect(result.suffixAlphaTokens).toEqual(['cqp']);
    });

    it('identifies multiple suffix alpha tokens', () => {
      const result = service.parseModelCode('mpg341cqpx', MONITORS_CONFIG);
      expect(result.suffixAlphaTokens).toEqual(['cqpx']);
    });

    it('returns empty suffixAlphaTokens when no numeric token present', () => {
      const result = service.parseModelCode('asus rog', MONITORS_CONFIG);
      expect(result.suffixAlphaTokens).toEqual([]);
    });

    it('returns empty suffixAlphaTokens when no alpha follows the numeric token', () => {
      const result = service.parseModelCode('mag341', MONITORS_CONFIG);
      expect(result.suffixAlphaTokens).toEqual([]);
    });

    it('returns valid=false for empty string', () => {
      const result = service.parseModelCode('', MONITORS_CONFIG);
      expect(result.valid).toBe(false);
    });

    it('returns valid=false when no words extracted', () => {
      const result = service.parseModelCode('---', MONITORS_CONFIG);
      expect(result.valid).toBe(false);
    });

    it('counts numeric tokens', () => {
      const result = service.parseModelCode('34gs95qe', MONITORS_CONFIG);
      expect(result.numericCount).toBe(2);
    });

    it('matches 4-digit refresh rate token via refresh rate rule', () => {
      const result = service.parseModelCode('1440hz', MONITORS_CONFIG);
      // Tokenizes to ['1440', 'hz']; '1440' is 4 digits — does not match `^\d{2,3}$`
      // But it matches `\d{3,4}(?:hz)?$` (refresh rate rule) → critical
      expect(result.criticalNumericTokens).toContain('1440');
    });
  });

  // ─── getTokenWeights ────────────────────────────────────────────────────────

  describe('getTokenWeights', () => {
    it('assigns weight 4 to 2-3 digit screen size token', () => {
      const weights = service.getTokenWeights(['34'], MONITORS_CONFIG);
      expect(weights[0]).toBe(4);
    });

    it('assigns weight 1.0 to pure alpha token with no matching rule', () => {
      const weights = service.getTokenWeights(['mpg'], MONITORS_CONFIG);
      expect(weights[0]).toBe(1.0);
    });

    it('picks max weight when multiple rules match', () => {
      // "340" matches both `^\d{2,3}$` (weight 4) and could match refresh rate rule
      const weights = service.getTokenWeights(['340'], MONITORS_CONFIG);
      expect(weights[0]).toBe(4); // max of applicable rules
    });

    it('returns correct weight array length', () => {
      const words = ['mpg', '341', 'cqpx'];
      const weights = service.getTokenWeights(words, MONITORS_CONFIG);
      expect(weights).toHaveLength(3);
    });
  });

  // ─── getCategoryConfig ──────────────────────────────────────────────────────

  describe('getCategoryConfig', () => {
    it('returns default config when no category provided', () => {
      const config = service.getCategoryConfig(undefined);
      expect(config.strictness).toBe('moderate');
      expect(config.numericTokenRules).toHaveLength(1);
      expect(config.numericTokenRules[0].critical).toBe(false);
    });

    it('returns default config when category has no matchingConfig', () => {
      const category = {
        id: 'cat-1',
        slug: 'cat-1',
      } as unknown as ProductCategory;
      const config = service.getCategoryConfig(category);
      expect(config.strictness).toBe('moderate');
    });

    it('returns category-specific config when category has matchingConfig', () => {
      const categoryConfigService = makeCategoryConfigService({
        monitors: {
          matchingConfig: {
            strictness: 'strict',
            numericTokenRules: [
              {
                pattern: '^\\d{2,3}$',
                weight: 4,
                description: 'Screen size',
                critical: true,
              },
            ],
          },
        },
      });
      const localService = new InputNormalizationService(
        makeMatchingConfigService(),
        categoryConfigService,
      );
      const category = {
        id: 'cat-monitors',
        slug: 'monitors',
      } as unknown as ProductCategory;
      const config = localService.getCategoryConfig(category);
      expect(config.strictness).toBe('strict');
      expect(config.numericTokenRules).toHaveLength(1);
      expect(config.numericTokenRules[0].critical).toBe(true);
      expect(config.numericTokenRules[0].pattern).toBeInstanceOf(RegExp);
    });

    it('caches config on second call (same category)', () => {
      const categoryConfigService = makeCategoryConfigService({
        monitors: {
          matchingConfig: {
            strictness: 'moderate',
            numericTokenRules: [],
          },
        },
      });
      const localService = new InputNormalizationService(
        makeMatchingConfigService(),
        categoryConfigService,
      );
      const category = {
        id: 'cat-monitors',
        slug: 'monitors',
      } as unknown as ProductCategory;
      const first = localService.getCategoryConfig(category);
      const second = localService.getCategoryConfig(category);
      expect(first).toBe(second); // same reference = cached
    });
  });
});
