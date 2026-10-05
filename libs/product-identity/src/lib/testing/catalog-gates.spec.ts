import { applyGates, primarySpecMismatches } from '../gates';
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
    //
    // `gender` was split out of it on 2026-09-17: one enum used to hold the
    // step-over geometry ebikeshop publishes and the rider speedbike names in
    // its titles, with no value in common.
    //
    // It moved from primarySpecs to matcherSpecs on 2026-10-03 (#9, issue 3).
    // A Férfi/Női difference is a different frame article of one model, but
    // the wave-1 shops can't keep frames apart: most never state the rider
    // (akosbike 0 of 200 titles, ambringa 3 of 86), and those that do label
    // KTM's low-step frame Női at one shop and Uniszex at another. As primary
    // it split one model across products and refused correct GTIN/MPN joins;
    // as a matcher spec a model's frames share a product, and Uniszex is
    // compatible with both (`matchingConfig.compatibleValues`).
    //
    // wheelSize left primarySpecs for offerLevelSpecs on 2026-10-05: Cube sells
    // one model on 27.5" wheels in size S and 29" in M–XL, under one article
    // code, so the wheel describes the listing, as the frame size does.
    expect(EBIKES.primarySpecs).toEqual([
      'modelYear',
      'batteryCapacity',
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
      'gender',
    ]);
    expect(EBIKES.matchingConfig?.specTolerances?.['modelYear']).toEqual({
      absolute: 0,
    });
    // A year apart is two products: more than the primary tier's 30, so even
    // identical names land below NEAR_MISS_SCORE and never reach review.
    expect(EBIKES.matchingConfig?.specMismatchPenalty).toEqual({ modelYear: 50 });
  });

  it('only ever reports gates the category configured, at their set severity', () => {
    const severities: Record<string, number> = {
      primarySpecMismatch: 30,
      modelNumberMismatch: 30,
      matcherSpecMismatch: 10,
    };

    const missingPenalties = EBIKES.matchingConfig?.missingSpecPenalty ?? {};
    const mismatchPenalties = EBIKES.matchingConfig?.specMismatchPenalty ?? {};

    for (const { query, candidate } of allScoredPairs()) {
      for (const gate of gatesBetween(query, candidate)) {
        if (gate.gate === 'specMissing') {
          expect(missingPenalties[gate.spec!]).toBe(gate.severity);
          continue;
        }
        expect(
          (gate.spec && mismatchPenalties[gate.spec]) ?? severities[gate.gate],
        ).toBe(gate.severity);
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
    it('reports a model year difference with both years, at the year’s own penalty', () => {
      const [a, b] = pairByKey('chacana lfc macina');

      expect(gatesBetween(a, b)).toEqual([
        {
          gate: 'primarySpecMismatch',
          spec: 'modelYear',
          severity: 50,
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

      // The year at its own penalty, the usage type at the primary tier's.
      expect(
        gates
          .map((gate) => [gate.spec, gate.severity])
          .sort(([x], [y]) => String(x).localeCompare(String(y))),
      ).toEqual([
        ['modelYear', 50],
        ['usageType', 30],
      ]);
    });
  });

  describe('matcher specs', () => {
    it('costs only 10 when a matcher spec disagrees', () => {
      const pairs = allScoredPairs().filter(({ query, candidate }) =>
        gatesBetween(query, candidate).some(
          (gate) => gate.gate === 'matcherSpecMismatch',
        ),
      );

      expect(pairs.length).toBeGreaterThan(0);
      for (const { query, candidate } of pairs) {
        for (const gate of gatesBetween(query, candidate)) {
          if (gate.gate === 'matcherSpecMismatch') expect(gate.severity).toBe(10);
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

    it('raises no mismatch gate when one side has no specs, only the missing-year penalty', () => {
      // Every stored product now carries at least one spec, so this is built
      // from a query with none — what a listing whose spec table did not
      // parse presents to matching. Nothing contradicts; the one thing it
      // costs is the model year the category will not match without.
      for (const other of CATALOG) {
        const specGates = applyGates({
          queryModel: other.nameKey,
          candidateModel: other.nameKey,
          querySpecs: undefined,
          candidateSpecs: other.specs,
          categoryConfig: EBIKES,
        });
        expect(specGates).toEqual(
          other.specs?.['modelYear']
            ? [
                {
                  gate: 'specMissing',
                  spec: 'modelYear',
                  severity: 25,
                  queryValue: null,
                  candidateValue: other.specs['modelYear'],
                },
              ]
            : [],
        );
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

  describe('compatible values and tolerances', () => {
    it('treats a more specific usage type as compatible with its parent', () => {
      // The catalog carries both "MTB" and "Összteleszkópos MTB"; the ebikes
      // compatible values say the latter is a kind of the former.
      const gates = applyGates({
        queryModel: 'same key',
        candidateModel: 'same key',
        querySpecs: { usageType: 'MTB' },
        candidateSpecs: { usageType: 'Összteleszkópos MTB' },
        categoryConfig: EBIKES,
      });

      expect(gates).toEqual([]);
    });

    it('prices a men\'s against a women\'s frame as a matcher spec, and lets Uniszex through', () => {
      const gatesOf = (queryGender: string, candidateGender: string) =>
        applyGates({
          queryModel: '720 macina style',
          candidateModel: '720 macina style',
          querySpecs: { gender: queryGender },
          candidateSpecs: { gender: candidateGender },
          categoryConfig: EBIKES,
        });

      // 10 points: identical names still attach at 90.
      expect(gatesOf('Férfi', 'Női')).toEqual([
        expect.objectContaining({ gate: 'matcherSpecMismatch', spec: 'gender', severity: 10 }),
      ]);
      expect(gatesOf('Uniszex', 'Férfi')).toEqual([]);
      expect(gatesOf('Női', 'Uniszex')).toEqual([]);
    });

    it('lets Unisex through in either spelling and any case', () => {
      const gatesOf = (queryGender: string, candidateGender: string) =>
        applyGates({
          queryModel: '720 macina style',
          candidateModel: '720 macina style',
          querySpecs: { gender: queryGender },
          candidateSpecs: { gender: candidateGender },
          categoryConfig: EBIKES,
        });

      expect(gatesOf('Unisex', 'Férfi')).toEqual([]);
      expect(gatesOf('NŐI', 'unisex')).toEqual([]);
      expect(gatesOf('uniszex', 'FÉRFI')).toEqual([]);
      expect(gatesOf('Unisex', 'Uniszex')).toEqual([]);
      expect(gatesOf('férfi', 'NŐI')).toEqual([
        expect.objectContaining({ gate: 'matcherSpecMismatch', spec: 'gender' }),
      ]);
    });

    it('never refuses an identifier join over the rider', () => {
      // bikelife calls KTM's low-step frame Női, bringaboard the same article
      // Uniszex; a product voted Férfi can hold either shop's listing.
      expect(
        primarySpecMismatches({
          querySpecs: { gender: 'Női' },
          candidateSpecs: { gender: 'Férfi' },
          categoryConfig: EBIKES,
        }),
      ).toEqual([]);
    });

    it('holds model year and battery capacity to an exact match', () => {
      const gates = applyGates({
        queryModel: 'same key',
        candidateModel: 'same key',
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
