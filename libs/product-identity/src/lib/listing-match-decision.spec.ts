import type { ProductCategoryConfig, ProductSpecs } from '@fittkereso-backend/database';
import { applyGates, scoreOf } from './gates';
import { decideListingMatch } from './listing-match-decision';

const candidate = (productId: string, score: number) => ({ productId, score });

describe('decideListingMatch', () => {
  it('attaches to the only candidate at 80 or above', () => {
    const only = candidate('only', 80);

    expect(decideListingMatch([candidate('near', 75), only, candidate('far', 40)])).toEqual({
      kind: 'attach',
      candidate: only,
    });
  });

  it('asks the LLM about every candidate at 70 or above when two score 80 or above', () => {
    expect(
      decideListingMatch([
        candidate('b', 82),
        candidate('far', 50),
        candidate('c', 71),
        candidate('a', 85),
      ]),
    ).toEqual({
      kind: 'ask_llm',
      candidates: [candidate('a', 85), candidate('b', 82), candidate('c', 71)],
    });
  });

  describe('when two or more candidates score 80 or above', () => {
    it('attaches a perfect score that leads the runner-up by 10 or more', () => {
      // akosbike's Nuroad C:62 Race 400X FE: speedbike's identical product at
      // 100, its non-FE and SLX twins at 81 and 85.
      const perfect = candidate('identical', 100);

      expect(
        decideListingMatch([candidate('slx-twin', 85), perfect, candidate('non-fe', 81)]),
      ).toEqual({ kind: 'attach', candidate: perfect });
    });

    it('attaches at a lead of exactly 10', () => {
      const perfect = candidate('identical', 100);

      expect(decideListingMatch([candidate('close', 90), perfect])).toEqual({
        kind: 'attach',
        candidate: perfect,
      });
    });

    it('does not pick when the lead is under 10', () => {
      expect(decideListingMatch([candidate('a', 100), candidate('b', 91)])).toEqual({
        kind: 'ask_llm',
        candidates: [candidate('a', 100), candidate('b', 91)],
      });
    });

    it('does not pick between two perfect scores', () => {
      // Two products already duplicating each other: the score can't choose.
      expect(decideListingMatch([candidate('a', 100), candidate('b', 100)])).toEqual({
        kind: 'ask_llm',
        candidates: [candidate('a', 100), candidate('b', 100)],
      });
    });

    it('does not pick a best below a perfect score, however far ahead', () => {
      expect(decideListingMatch([candidate('a', 99), candidate('b', 80)])).toEqual({
        kind: 'ask_llm',
        candidates: [candidate('a', 99), candidate('b', 80)],
      });
    });
  });

  it('asks the LLM when no candidate reaches 80 but some reach 70', () => {
    expect(decideListingMatch([candidate('a', 79), candidate('b', 70), candidate('c', 69)])).toEqual({
      kind: 'ask_llm',
      candidates: [candidate('a', 79), candidate('b', 70)],
    });
  });

  it('creates without asking the LLM when no candidate reaches 70', () => {
    expect(decideListingMatch([candidate('a', 69)])).toEqual({ kind: 'not_found' });
    expect(decideListingMatch([])).toEqual({ kind: 'not_found' });
  });

  it('never attaches identical names with one primary mismatch, and creates with two', () => {
    const KEY = '140 hybrid stereo';
    const config: ProductCategoryConfig = {
      primarySpecs: ['modelYear', 'batteryCapacity'],
      matchingConfig: {
        specTolerances: { modelYear: { absolute: 0 }, batteryCapacity: { absolute: 0 } },
      },
    };
    const scoreAgainst = (candidateSpecs: ProductSpecs) =>
      scoreOf(
        100,
        applyGates({
          queryKey: KEY,
          candidateKey: KEY,
          querySpecs: { modelYear: 2024, batteryCapacity: 750 },
          candidateSpecs,
          categoryConfig: config,
        }),
      );

    const oneMismatch = candidate('year', scoreAgainst({ modelYear: 2023, batteryCapacity: 750 }));
    const twoMismatches = candidate('both', scoreAgainst({ modelYear: 2023, batteryCapacity: 500 }));

    expect(decideListingMatch([oneMismatch])).toEqual({ kind: 'ask_llm', candidates: [oneMismatch] });
    expect(decideListingMatch([twoMismatches])).toEqual({ kind: 'not_found' });
  });
});

describe('decideListingMatch in key mode', () => {
  type Gate = 'primarySpecMismatch' | 'matcherSpecMismatch' | 'modelNumberMismatch' | 'specMissing';
  const keyed = (
    productId: string,
    score: number,
    match: boolean | undefined,
    gates: Gate[] = [],
    createdAt = '2026-01-01',
  ) => ({
    productId,
    score,
    matcherModelMatch: match,
    failedGates: gates.map((gate) => ({ gate })),
    keyScore: scoreOf(
      100,
      gates
        .filter((gate) => gate !== 'modelNumberMismatch')
        .map((gate) => ({ gate, severity: gate === 'primarySpecMismatch' ? 30 : 10, queryValue: null, candidateValue: null })),
    ),
    createdAt: new Date(createdAt),
  });
  const byKey = (candidates: ReturnType<typeof keyed>[], shortKey = false) =>
    decideListingMatch(candidates, { mode: 'key', shortKey });

  it('attaches on equal keys and clean spec gates however low the name scores', () => {
    // "Tour CX 830" against "Macina Tour CX830": the model-number gate sinks the name.
    const sameBike = keyed('same', 27, true, ['modelNumberMismatch']);

    expect(byKey([sameBike])).toEqual({ kind: 'attach', candidate: sameBike });
  });

  it('never attaches a perfect name with another key, and asks the LLM about it', () => {
    // "Style 810" against "Style 810 Di2".
    const variant = keyed('variant', 100, false);

    expect(byKey([variant])).toEqual({ kind: 'ask_llm', candidates: [variant] });
  });

  it('keeps a candidate the spec gates bring below 80 from attaching, keys or not', () => {
    // Equal keys, a year apart (a primary mismatch) and one matcher spec off.
    const lastYear = keyed('last-year', 100, true, ['primarySpecMismatch']);

    expect(byKey([lastYear])).toEqual({ kind: 'not_found' });
  });

  it("attaches a men's frame to the women's at 90: one matcher spec apart", () => {
    const otherFrame = keyed('other-frame', 90, true, ['matcherSpecMismatch']);

    expect(byKey([otherFrame])).toEqual({ kind: 'attach', candidate: otherFrame });
  });

  it('sends the LLM only names at 70 with no primary and at most one matcher contradiction', () => {
    const clean = keyed('clean', 100, false);
    const oneOff = keyed('one-off', 90, false, ['matcherSpecMismatch']);
    const twoOff = keyed('two-off', 80, false, ['matcherSpecMismatch', 'matcherSpecMismatch']);
    const primary = keyed('primary', 70, false, ['primarySpecMismatch']);
    const weakName = keyed('weak-name', 69, false);
    const missingSpec = keyed('missing', 75, false, ['specMissing']);

    expect(byKey([twoOff, weakName, primary, oneOff, missingSpec, clean])).toEqual({
      kind: 'ask_llm',
      candidates: [clean, oneOff, missingSpec],
    });
    expect(byKey([twoOff, primary, weakName])).toEqual({ kind: 'not_found' });
  });

  it('wants the name score at 80 too behind a one-word key', () => {
    const weakName = keyed('weak-name', 75, true);
    const strongName = keyed('strong-name', 85, true);

    expect(byKey([weakName], true)).toEqual({ kind: 'ask_llm', candidates: [weakName] });
    expect(byKey([weakName, strongName], true)).toEqual({ kind: 'attach', candidate: strongName });
  });

  it('picks among products sharing the key by spec gates, then name, then age — never a tie that blocks', () => {
    const older = keyed('older', 95, true, [], '2025-01-01');
    const newer = keyed('newer', 95, true, [], '2026-01-01');
    const betterName = keyed('better-name', 98, true, ['matcherSpecMismatch']);

    expect(byKey([newer, betterName, older])).toEqual({ kind: 'attach', candidate: older });
  });

  it('never attaches a candidate whose key is unknown', () => {
    const unkeyed = keyed('unkeyed', 100, undefined);

    expect(byKey([unkeyed])).toEqual({ kind: 'ask_llm', candidates: [unkeyed] });
  });
});
