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
