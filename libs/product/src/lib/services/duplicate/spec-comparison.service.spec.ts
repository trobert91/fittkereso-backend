import { ProductSpecs } from '@fittkereso-backend/database';
import { SpecComparisonService } from './spec-comparison.service';

describe('SpecComparisonService', () => {
  let service: SpecComparisonService;

  beforeEach(() => {
    service = new SpecComparisonService();
  });

  // ═══ compareSpecs ═════════════════════════════════════════════════════════

  describe('compareSpecs', () => {
    it('returns empty result when specsA is undefined', () => {
      const result = service.compareSpecs({
        specsA: undefined,
        specsB: { screenSize: 27 },
      });
      expect(result.comparableCount).toBe(0);
    });

    it('returns empty result when specsB is undefined', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27 },
        specsB: undefined,
      });
      expect(result.comparableCount).toBe(0);
    });

    it('compares all shared keys', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27, refreshRate: 144, panelType: 'IPS' },
        specsB: { screenSize: 27, panelType: 'IPS', curvature: 'flat' },
      });
      expect(result.comparableCount).toBe(2); // screenSize and panelType
      expect(result.matchingCount).toBe(2);
    });

    it('counts matching specs', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27, refreshRate: 144 },
        specsB: { screenSize: 27, refreshRate: 144 },
        primarySpecs: ['screenSize', 'refreshRate'],
      });
      expect(result.comparableCount).toBe(2);
      expect(result.matchingCount).toBe(2);
      expect(result.primaryMismatches).toBe(0);
    });

    it('detects primary mismatch', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27, refreshRate: 144 },
        specsB: { screenSize: 34, refreshRate: 144 },
        primarySpecs: ['screenSize', 'refreshRate'],
      });
      expect(result.primaryMismatches).toBe(1);
      expect(result.matchingCount).toBe(1);
    });

    it('only compares primarySpecs keys when provided', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27, refreshRate: 144 },
        specsB: { screenSize: 27, refreshRate: 240 },
        primarySpecs: ['screenSize'],
      });
      // Only screenSize compared (matches), refreshRate ignored
      expect(result.comparableCount).toBe(1);
      expect(result.matchingCount).toBe(1);
      expect(result.primaryMismatches).toBe(0);
    });

    it('falls back to all shared keys when no primarySpecs provided', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27 },
        specsB: { screenSize: 34 },
      });
      expect(result.comparableCount).toBe(1);
      expect(result.nonPrimaryMismatches).toBe(1);
    });

    it('skips keys where either value is nil', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27, refreshRate: undefined },
        specsB: { screenSize: 27, refreshRate: 144 },
      });
      expect(result.comparableCount).toBe(1);
      expect(result.matchingCount).toBe(1);
    });

    it('counts hierarchy compatible as matching', () => {
      const result = service.compareSpecs({
        specsA: { panelType: 'OLED' },
        specsB: { panelType: 'QD-OLED' },
        primarySpecs: ['panelType'],
        matcherSpecHierarchies: {
          panelType: { OLED: ['QD-OLED', 'W-OLED'] },
        },
      });
      expect(result.matchingCount).toBe(1);
      expect(result.primaryMismatches).toBe(0);
      expect(result.details[0].match).toBe('compatible');
    });

    it('provides per-spec details', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27, panelType: 'IPS' },
        specsB: { screenSize: 34, panelType: 'IPS' },
        primarySpecs: ['screenSize', 'panelType'],
      });
      expect(result.details).toHaveLength(2);
      expect(result.details[0]).toEqual({
        key: 'screenSize',
        isPrimary: true,
        isMatcher: false,
        valueA: 27,
        valueB: 34,
        match: 'mismatch',
      });
      expect(result.details[1]).toEqual({
        key: 'panelType',
        isPrimary: true,
        isMatcher: false,
        valueA: 'IPS',
        valueB: 'IPS',
        match: 'match',
      });
    });

    // ─── matcherSpecs ─────────────────────────────────────────────────────

    it('includes matcherSpecs keys in comparison alongside primarySpecs', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27, brightness: 1000 },
        specsB: { screenSize: 27, brightness: 250 },
        primarySpecs: ['screenSize'],
        matcherSpecs: ['brightness'],
      });
      expect(result.comparableCount).toBe(2);
      expect(result.primaryMismatches).toBe(0);
      expect(result.matcherSpecMismatches).toBe(1);
      expect(result.matchingCount).toBe(1);
    });

    it('treats missing candidate matcherSpecs values as matcher mismatch', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27, brightness: 1000 },
        specsB: { screenSize: 27 },
        primarySpecs: ['screenSize'],
        matcherSpecs: ['brightness'],
      });
      expect(result.comparableCount).toBe(2);
      expect(result.matcherSpecMismatches).toBe(1);
      expect(result.primaryMismatches).toBe(0);
    });

    it('treats spec in both primarySpecs and matcherSpecs as primary', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27 },
        specsB: { screenSize: 34 },
        primarySpecs: ['screenSize'],
        matcherSpecs: ['screenSize'],
      });
      expect(result.primaryMismatches).toBe(1);
      expect(result.matcherSpecMismatches).toBe(0);
    });

    it('marks matcherSpec details with isMatcher flag', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27, brightness: 1000 },
        specsB: { screenSize: 27, brightness: 250 },
        primarySpecs: ['screenSize'],
        matcherSpecs: ['brightness'],
      });
      const brightnessDetail = result.details.find(
        (d) => d.key === 'brightness',
      );
      expect(brightnessDetail?.isPrimary).toBe(false);
      expect(brightnessDetail?.isMatcher).toBe(true);
      expect(brightnessDetail?.match).toBe('mismatch');
    });

    it('matcherSpecs matching values count as confirmed', () => {
      const result = service.compareSpecs({
        specsA: { screenSize: 27, brightness: 1000 },
        specsB: { screenSize: 27, brightness: 1000 },
        primarySpecs: ['screenSize'],
        matcherSpecs: ['brightness'],
      });
      expect(result.matchingCount).toBe(2);
      expect(result.matcherSpecMismatches).toBe(0);
    });
  });

  // ═══ computeSpecSimilarityScore ═════════════════════════════════════════════════

  describe('computeSpecSimilarityScore', () => {
    it('returns 0 for undefined specsA', () => {
      expect(
        service.computeSpecSimilarityScore(undefined, { screenSize: 27 }),
      ).toBe(0);
    });

    it('returns 0 for undefined specsB', () => {
      expect(
        service.computeSpecSimilarityScore({ screenSize: 27 }, undefined),
      ).toBe(0);
    });

    it('returns 0 for empty specsA', () => {
      expect(service.computeSpecSimilarityScore({}, { screenSize: 27 })).toBe(
        0,
      );
    });

    it('returns 1.0 for full match (1 spec)', () => {
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27' },
          { screenSize: 27 },
        ),
      ).toBe(1);
    });

    it('returns 1.0 for full match (multiple specs)', () => {
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27', panelType: 'IPS' },
          { screenSize: 27, panelType: 'IPS' },
        ),
      ).toBe(1);
    });

    it('returns -2.0 for single contradiction', () => {
      expect(
        service.computeSpecSimilarityScore(
          { refreshRate: '175' },
          { refreshRate: 240 },
        ),
      ).toBe(-2);
    });

    it('computes partial score (1 match, 1 contradiction)', () => {
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27', panelType: 'IPS' },
          { screenSize: 27, panelType: 'VA' },
        ),
      ).toBe(-0.5); // (1 - 2*1) / 2
    });

    it('counts missing candidate specs as matcher-level contradiction', () => {
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27', refreshRate: '240' },
          { screenSize: 27 },
        ),
      ).toBe(0); // screenSize matches, refreshRate nil → matcher contradiction → (1-1)/2=0
    });

    it('treats hierarchy compatible as confirmed', () => {
      const hierarchies = {
        panelType: { OLED: ['QD-OLED', 'W-OLED'] },
      };
      expect(
        service.computeSpecSimilarityScore(
          { panelType: 'QD-OLED' },
          { panelType: 'OLED' },
          hierarchies,
        ),
      ).toBe(1);
    });

    it('skips keys with nil values in specsA', () => {
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27', refreshRate: undefined },
          { screenSize: 27, refreshRate: 144 },
        ),
      ).toBe(1); // only screenSize counted, 1/1
    });

    it('only compares primarySpecs keys when provided', () => {
      // Only refreshRate is compared (primary), screenSize is ignored
      // refreshRate mismatches: (0 - 2*1) / 1 = -2
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27', refreshRate: '175' },
          { screenSize: 27, refreshRate: 240 },
          undefined,
          ['refreshRate'],
        ),
      ).toBe(-2);
    });

    it('ignores non-primary specs even when they match', () => {
      // Only refreshRate compared, screenSize match is ignored
      // refreshRate matches: (1 - 0) / 1 = 1
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27', refreshRate: '144' },
          { screenSize: 34, refreshRate: 144 },
          undefined,
          ['refreshRate'],
        ),
      ).toBe(1);
    });

    it('compares multiple primary specs', () => {
      // screenSize matches, refreshRate mismatches, panelType mismatches
      // (1 - 2*2) / 3 = -1
      const score = service.computeSpecSimilarityScore(
        { screenSize: '27', refreshRate: '100', panelType: 'IPS' },
        { screenSize: 27, refreshRate: 165, panelType: 'VA' },
        undefined,
        ['screenSize', 'refreshRate', 'panelType'],
      );
      expect(score).toBe(-1);
    });

    it('returns 0 when no primarySpecs keys exist in either side', () => {
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27' },
          { screenSize: 27 },
          undefined,
          ['refreshRate'],
        ),
      ).toBe(0);
    });

    // ─── matcherSpecs ─────────────────────────────────────────────────────

    it('includes matcherSpecs in comparison set', () => {
      // screenSize matches (primary), brightness mismatches (matcher, weight 1)
      // (1 - 1) / 2 = 0
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27', brightness: '1000' },
          { screenSize: 27, brightness: 250 },
          undefined,
          ['screenSize'],
          ['brightness'],
        ),
      ).toBe(0);
    });

    it('matcher contradiction has lower weight than primary', () => {
      // Primary mismatch: (0 - 2) / 1 = -2
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27' },
          { screenSize: 34 },
          undefined,
          ['screenSize'],
        ),
      ).toBe(-2);

      // Matcher mismatch: (0 - 1) / 1 = -1
      expect(
        service.computeSpecSimilarityScore(
          { brightness: '1000' },
          { brightness: 250 },
          undefined,
          [],
          ['brightness'],
        ),
      ).toBe(-1);
    });

    it('treats spec in both primarySpecs and matcherSpecs as primary weight', () => {
      // screenSize in both → primary weight (2), mismatch → (0 - 2) / 1 = -2
      expect(
        service.computeSpecSimilarityScore(
          { screenSize: '27' },
          { screenSize: 34 },
          undefined,
          ['screenSize'],
          ['screenSize'],
        ),
      ).toBe(-2);
    });
  });

  // ═══ Value Comparison (tested through public methods) ═════════════════════

  describe('value comparison', () => {
    const affinity = (
      a: ProductSpecs,
      b: ProductSpecs,
      h?: Record<string, Record<string, string[]>>,
    ) => service.computeSpecSimilarityScore(a, b, h);

    describe('numeric', () => {
      it('matches exact numbers', () => {
        expect(affinity({ val: '27' }, { val: 27 })).toBe(1);
      });

      it('matches numbers within 5% tolerance', () => {
        expect(affinity({ val: '240' }, { val: 244 })).toBe(1);
      });

      it('rejects numbers outside 5% tolerance', () => {
        expect(affinity({ val: '240' }, { val: 144 })).toBe(-2);
      });

      it('matches number-in-string vs raw number ("240Hz" vs 240)', () => {
        expect(affinity({ val: '240Hz' }, { val: 240 })).toBe(1);
      });

      it('matches number-in-string vs number-in-string', () => {
        expect(affinity({ val: '240Hz' }, { val: '240 Hz' })).toBe(1);
      });

      it('does not fuzzy-match different numeric values ("39" vs "34")', () => {
        expect(affinity({ val: '39' }, { val: '34' })).toBe(-2);
      });

      it('matches typed numbers via tolerance', () => {
        const result = service.compareSpecs({
          specsA: { refreshRate: 240 },
          specsB: { refreshRate: 244 },

          primarySpecs: [],
        });
        expect(result.matchingCount).toBe(1);
      });
    });

    describe('string', () => {
      it('matches exact case-insensitive', () => {
        expect(affinity({ val: 'IPS' }, { val: 'ips' })).toBe(1);
      });

      it('matches with unit stripping ("27 inch" vs "27")', () => {
        expect(affinity({ val: '27 inch' }, { val: '27' })).toBe(1);
      });

      it('matches with hz stripping ("240Hz" vs "240")', () => {
        expect(affinity({ val: '240Hz' }, { val: '240' })).toBe(1);
      });

      it('matches via word-boundary containment', () => {
        expect(affinity({ val: 'Fast IPS' }, { val: 'fast ips' })).toBe(1);
      });

      it('matches via Levenshtein for short strings (distance 1)', () => {
        // "flat" vs "flai" — Levenshtein distance 1, both non-numeric
        expect(affinity({ val: 'flat' }, { val: 'flai' })).toBe(1);
      });

      it('rejects different panel types', () => {
        expect(affinity({ val: 'IPS' }, { val: 'VA' })).toBe(-2);
      });

      it('handles dash-to-space normalization ("QD-OLED" vs "QD OLED")', () => {
        expect(affinity({ val: 'QD-OLED' }, { val: 'QD OLED' })).toBe(1);
      });
    });

    describe('boolean', () => {
      it('matches same booleans', () => {
        const result = service.compareSpecs({
          specsA: { hdr: true },
          specsB: { hdr: true },

          primarySpecs: [],
        });
        expect(result.matchingCount).toBe(1);
      });

      it('rejects different booleans', () => {
        const result = service.compareSpecs({
          specsA: { hdr: true },
          specsB: { hdr: false },

          primarySpecs: [],
        });
        expect(result.nonPrimaryMismatches).toBe(1);
      });

      it('matches string "true" vs boolean true', () => {
        expect(affinity({ hdr: 'true' }, { hdr: true })).toBe(1);
      });

      it('matches string "false" vs boolean false', () => {
        expect(affinity({ curved: 'false' }, { curved: false })).toBe(1);
      });
    });

    describe('arrays', () => {
      it('matches identical arrays', () => {
        const result = service.compareSpecs({
          specsA: { ports: ['USB-C', 'HDMI'] },
          specsB: { ports: ['USB-C', 'HDMI'] },

          primarySpecs: [],
        });
        expect(result.matchingCount).toBe(1);
      });

      it('matches arrays in different order', () => {
        const result = service.compareSpecs({
          specsA: { ports: ['HDMI', 'USB-C'] },
          specsB: { ports: ['USB-C', 'HDMI'] },

          primarySpecs: [],
        });
        expect(result.matchingCount).toBe(1);
      });

      it('matches when one array is subset of the other', () => {
        const result = service.compareSpecs({
          specsA: { ports: ['USB-C'] },
          specsB: { ports: ['USB-C', 'HDMI', 'DisplayPort'] },

          primarySpecs: [],
        });
        expect(result.matchingCount).toBe(1);
      });

      it('matches when second array is subset of first', () => {
        const result = service.compareSpecs({
          specsA: { ports: ['USB-C', 'HDMI', 'DisplayPort'] },
          specsB: { ports: ['HDMI'] },

          primarySpecs: [],
        });
        expect(result.matchingCount).toBe(1);
      });

      it('rejects arrays with no subset relationship', () => {
        const result = service.compareSpecs({
          specsA: { ports: ['USB-C', 'Thunderbolt'] },
          specsB: { ports: ['HDMI', 'DisplayPort'] },

          primarySpecs: [],
        });
        expect(result.nonPrimaryMismatches).toBe(1);
      });

      it('array subset matching is case-insensitive', () => {
        const result = service.compareSpecs({
          specsA: { ports: ['usb-c'] },
          specsB: { ports: ['USB-C', 'HDMI'] },

          primarySpecs: [],
        });
        expect(result.matchingCount).toBe(1);
      });
    });

    describe('hierarchy', () => {
      const hierarchies = {
        panelType: {
          OLED: ['QD-OLED', 'W-OLED', 'WOLED'],
          LCD: ['IPS', 'VA', 'TN'],
        },
      };

      it('parent vs child is compatible', () => {
        const result = service.compareSpecs({
          specsA: { panelType: 'OLED' },
          specsB: { panelType: 'QD-OLED' },

          primarySpecs: ['panelType'],
          matcherSpecHierarchies: hierarchies,
        });
        expect(result.details[0].match).toBe('compatible');
        expect(result.matchingCount).toBe(1);
        expect(result.primaryMismatches).toBe(0);
      });

      it('child vs parent is compatible', () => {
        const result = service.compareSpecs({
          specsA: { panelType: 'QD-OLED' },
          specsB: { panelType: 'OLED' },

          primarySpecs: [],
          matcherSpecHierarchies: hierarchies,
        });
        expect(result.details[0].match).toBe('compatible');
      });

      it('siblings under same parent are still mismatch', () => {
        const result = service.compareSpecs({
          specsA: { panelType: 'IPS' },
          specsB: { panelType: 'VA' },

          primarySpecs: [],
          matcherSpecHierarchies: hierarchies,
        });
        expect(result.details[0].match).toBe('mismatch');
      });

      it('values from different parent groups are mismatch', () => {
        const result = service.compareSpecs({
          specsA: { panelType: 'QD-OLED' },
          specsB: { panelType: 'IPS' },

          primarySpecs: [],
          matcherSpecHierarchies: hierarchies,
        });
        expect(result.details[0].match).toBe('mismatch');
      });

      it('hierarchy is case-insensitive', () => {
        const result = service.compareSpecs({
          specsA: { panelType: 'oled' },
          specsB: { panelType: 'qd-oled' },

          primarySpecs: [],
          matcherSpecHierarchies: hierarchies,
        });
        expect(result.details[0].match).toBe('compatible');
      });

      it('modifier-prefixed value matches parent ("matte WOLED" vs "OLED")', () => {
        const result = service.compareSpecs({
          specsA: { panelType: 'matte WOLED' },
          specsB: { panelType: 'OLED' },
          primarySpecs: ['panelType'],
          matcherSpecHierarchies: hierarchies,
        });
        expect(result.details[0].match).toBe('compatible');
        expect(result.primaryMismatches).toBe(0);
      });

      it('modifier-prefixed value matches sibling child ("glossy QD-OLED" vs "QD-OLED")', () => {
        const result = service.compareSpecs({
          specsA: { panelType: 'glossy QD-OLED' },
          specsB: { panelType: 'QD-OLED' },
          primarySpecs: ['panelType'],
          matcherSpecHierarchies: hierarchies,
        });
        expect(result.details[0].match).toBe('compatible');
        expect(result.primaryMismatches).toBe(0);
      });

      it('modifier-prefixed values from different groups are still mismatch', () => {
        const result = service.compareSpecs({
          specsA: { panelType: 'matte WOLED' },
          specsB: { panelType: 'IPS' },
          primarySpecs: ['panelType'],
          matcherSpecHierarchies: hierarchies,
        });
        expect(result.details[0].match).toBe('mismatch');
        expect(result.primaryMismatches).toBe(1);
      });
    });

    describe('mixed types', () => {
      it('string number vs raw number ("27" vs 27)', () => {
        expect(affinity({ val: '27' }, { val: 27 })).toBe(1);
      });

      it('skips comparison for mixed numeric/string when no numeric parse possible', () => {
        // "QD-OLED" vs 240 — string coercion, no numeric match, no fuzzy match
        expect(affinity({ val: 'QD-OLED' }, { val: 240 })).toBe(-2);
      });
    });
  });
});
