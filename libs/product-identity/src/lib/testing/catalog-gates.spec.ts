import { applyGates } from '../gates';
import {
  CATALOG,
  EBIKES,
  allScoredPairs,
  byKey,
  gatesBetween,
  oneByKey,
  pairByKey,
} from './catalog';

describe('gates on the real KTM catalog', () => {
  it('reads the category config the ebikes source actually ships', () => {
    // frameType moved from matcherSpecs to primarySpecs on 2026-09-16: the
    // shops publish a real frame shape (Magas / Trapéz / Alacsony) and a
    // different shape is a different product, so it costs 30, not 5.
    expect(EBIKES.primarySpecs).toEqual([
      'modelYear',
      'batteryCapacity',
      'wheelSize',
      'torque',
      'usageType',
      'frameType',
    ]);
    expect(EBIKES.matcherSpecs).toEqual([
      'motorPower',
      'weight',
      'frameMaterial',
      'gearCount',
      'topSpeed',
    ]);
    expect(EBIKES.matchingConfig?.specTolerances?.['modelYear']).toEqual({
      absolute: 0,
    });
  });

  it('only ever reports gates the category configured, at their set severity', () => {
    const severities: Record<string, number> = {
      primarySpecMismatch: 30,
      modelNumberMismatch: 30,
      matcherSpecMismatch: 5,
    };

    for (const { query, candidate } of allScoredPairs()) {
      for (const gate of gatesBetween(query, candidate)) {
        expect(severities[gate.gate]).toBe(gate.severity);
        if (gate.gate === 'primarySpecMismatch') {
          expect(EBIKES.primarySpecs).toContain(gate.spec);
        }
        if (gate.gate === 'matcherSpecMismatch') {
          expect(EBIKES.matcherSpecs).toContain(gate.spec);
        }
        if (gate.gate === 'modelNumberMismatch') {
          expect(gate.spec).toBeUndefined();
        }
      }
    }
  });

  it('always reports both sides of a failed gate', () => {
    for (const { query, candidate } of allScoredPairs()) {
      for (const gate of gatesBetween(query, candidate)) {
        expect(gate.queryValue).toBeDefined();
        expect(gate.candidateValue).toBeDefined();
        expect(gate.queryValue).not.toEqual(gate.candidateValue);
      }
    }
  });

  describe('primary specs', () => {
    it('reports a model year difference with both years', () => {
      const [a, b] = pairByKey('chacana lfc macina');

      expect(gatesBetween(a, b)).toEqual([
        {
          gate: 'primarySpecMismatch',
          spec: 'modelYear',
          severity: 30,
          queryValue: a.specs?.['modelYear'],
          candidateValue: b.specs?.['modelYear'],
        },
      ]);
      expect(a.specs?.['modelYear']).not.toBe(b.specs?.['modelYear']);
    });

    it('stacks two primary mismatches on one pair', () => {
      // The same city bike listed a year apart, and the two shops disagree on
      // whether it is a City or a Trekking bike.
      const [a, b] = pairByKey('810 belt city macina');
      const gates = gatesBetween(a, b);

      expect(gates.map((gate) => gate.spec).sort()).toEqual([
        'modelYear',
        'usageType',
      ]);
      expect(gates.every((gate) => gate.severity === 30)).toBe(true);
    });
  });

  describe('matcher specs', () => {
    it('costs only 5 when a matcher spec disagrees', () => {
      const pairs = allScoredPairs().filter(({ query, candidate }) =>
        gatesBetween(query, candidate).some(
          (gate) => gate.gate === 'matcherSpecMismatch',
        ),
      );

      expect(pairs.length).toBeGreaterThan(0);
      for (const { query, candidate } of pairs) {
        for (const gate of gatesBetween(query, candidate)) {
          if (gate.gate === 'matcherSpecMismatch') expect(gate.severity).toBe(5);
        }
      }
    });
  });

  describe('missing values', () => {
    it('skips a spec that only one side has', () => {
      // Several shared-key pairs have a torque reading from one shop only.
      const [a, b] = pairByKey('892 abs lfc macina team');
      const missingOnOneSide =
        (a.specs?.['torque'] === undefined) !== (b.specs?.['torque'] === undefined);

      expect(missingOnOneSide).toBe(true);
      expect(gatesBetween(a, b).map((gate) => gate.spec)).not.toContain('torque');
    });

    it('raises no spec gate at all when one side has no specs', () => {
      // Every stored product now carries at least one spec, so this is built
      // from a query with none — what a listing whose spec table did not
      // parse presents to matching.
      for (const other of CATALOG) {
        const specGates = applyGates({
          queryKey: other.nameKey,
          candidateKey: other.nameKey,
          querySpecs: undefined,
          candidateSpecs: other.specs,
          categoryConfig: EBIKES,
        });
        expect(specGates).toEqual([]);
      }
    });
  });

  describe('model numbers', () => {
    it('separates sibling models that differ only by their number', () => {
      const [lycan771] = byKey('771 di2 glorious lycan macina');
      const [lycan772] = byKey('772 di2 glorious lycan macina');

      // Every word carrying a digit counts as a model number, so the groupset
      // token "di2" travels with them. Harmless here — it appears on both
      // sides, and neither set contains the other, so the gate still fires.
      expect(gatesBetween(lycan771, lycan772)).toEqual([
        expect.objectContaining({
          gate: 'modelNumberMismatch',
          severity: 30,
          queryValue: ['771', 'di2'],
          candidateValue: ['772', 'di2'],
        }),
      ]);
    });

    it('stays quiet when one name simply prints more of the number set', () => {
      // "8973 kapoho macina" vs "8973 kapoho l macina": same number, one shop
      // adds a frame-size letter, so neither set contradicts the other.
      const kapoho = oneByKey('8973 kapoho macina');
      const kapohoL = oneByKey('8973 kapoho l macina');

      expect(
        gatesBetween(kapoho, kapohoL).filter(
          (gate) => gate.gate === 'modelNumberMismatch',
        ),
      ).toEqual([]);
    });
  });

  describe('hierarchies and tolerances', () => {
    it('treats a more specific usage type as compatible with its parent', () => {
      // The catalog carries both "MTB" and "Összteleszkópos MTB"; the ebikes
      // hierarchy says the latter is a kind of the former.
      const gates = applyGates({
        queryKey: 'same key',
        candidateKey: 'same key',
        querySpecs: { usageType: 'MTB' },
        candidateSpecs: { usageType: 'Összteleszkópos MTB' },
        categoryConfig: EBIKES,
      });

      expect(gates).toEqual([]);
    });

    it('holds model year and battery capacity to an exact match', () => {
      const gates = applyGates({
        queryKey: 'same key',
        candidateKey: 'same key',
        querySpecs: { modelYear: 2025, batteryCapacity: 750 },
        candidateSpecs: { modelYear: 2026, batteryCapacity: 800 },
        categoryConfig: EBIKES,
      });

      expect(gates.map((gate) => gate.spec).sort()).toEqual([
        'batteryCapacity',
        'modelYear',
      ]);
    });
  });
});
