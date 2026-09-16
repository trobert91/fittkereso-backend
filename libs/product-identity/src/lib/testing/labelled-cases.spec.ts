import { ACCEPT_SCORE, NEAR_MISS_SCORE } from '../product-identity.constants';
import {
  LABELLED_CASES,
  LabelledCase,
  REVIEWED_AT,
  describeCase,
  differentPairs,
  labelledCases,
  trueMatches,
} from './labelled-cases';

/**
 * §11.3 — the four aggregate rates, measured against a person's verdicts rather
 * than against what the old matcher happened to do.
 *
 * Read the denominators before the percentages. These 43 pairs are the two
 * buckets where the answer was genuinely unclear; the buckets a stated rule
 * already settles were deliberately left out (§11.2, and the comment on
 * `labelled-cases.ts`). So a rate here is a rate over hard cases only, and the
 * two §11.3 targets — 70% of true matches auto-attaching, 95% reaching
 * NEAR_MISS_SCORE — were written for a mixed set of ~60 true attaches. They are
 * not met on this set, and the last describe block is the evidence that no
 * choice of constants would meet them either.
 *
 * The two safety assertions, which are the ones that gate the scraper switch,
 * are met outright: nothing the reviewer called a different bike auto-attaches,
 * and nothing they called a different bike even reaches ACCEPT_SCORE.
 */
function pin(cases: LabelledCase[]): string[] {
  return cases.map((one) => `${one.slug} ${one.score} ${describeCase(one)}`);
}

describe('the labelled pair set', () => {
  it('is 43 cases a person reviewed, 42 of which carry a usable label', () => {
    expect(REVIEWED_AT.slice(0, 10)).toBe('2026-09-16');
    expect(LABELLED_CASES).toHaveLength(43);
    expect(labelledCases()).toHaveLength(42);
    expect(trueMatches()).toHaveLength(8);
    expect(differentPairs()).toHaveLength(34);

    // The one skip is a pair whose two shop links could not be compared.
    const skipped = LABELLED_CASES.filter((one) => one.verdict === 'skipped');
    expect(skipped.map((one) => one.slug)).toEqual(['c004']);
  });

  it('draws only from the two buckets where the answer was unclear', () => {
    const rules = [...new Set(LABELLED_CASES.map((one) => one.rule))].sort();

    expect(rules).toEqual(['frame token', 'other naming difference']);
  });

  it('resolves every side to the frozen catalog', () => {
    for (const one of LABELLED_CASES) {
      expect(one.a.id).not.toBe(one.b.id);
      expect(one.score).toBeGreaterThanOrEqual(1);
      expect(one.score).toBeLessThanOrEqual(100);
    }
  });
});

describe('§11.3 rate 1 — no different bike is ever auto-attached', () => {
  it('attaches nothing the reviewer called a different bike', () => {
    const wrong = differentPairs().filter((one) => one.outcome === 'attach');

    expect(pin(wrong)).toEqual([]);
  });

  it('and none of them even reaches ACCEPT_SCORE', () => {
    // §11.3's fourth assertion. The highest a "different" pair reaches is 79,
    // one point below the bar — c009 and c010, the Master against the Prestige.
    const reaching = differentPairs().filter((one) => one.score >= ACCEPT_SCORE);

    expect(pin(reaching)).toEqual([]);
    expect(Math.max(...differentPairs().map((one) => one.score))).toBe(79);
  });

  it('separates every frame shape the reviewer called a different bike', () => {
    // The four cases the reviewer annotated in their own words — "different
    // frameTypes, different products". Each was a false attach or a near miss
    // when they reviewed it, because ebikeshop's Váztípus never reached
    // frameType; all four gate on it now.
    const annotated = ['c002', 'c006', 'c008', 'c011'].map((slug) => {
      const one = LABELLED_CASES.find((c) => c.slug === slug);
      if (!one) throw new Error(`no case ${slug}`);
      return one;
    });

    for (const one of annotated) {
      expect(one.verdict).toBe('different');
      expect(one.note).toMatch(/frameType|frametype/i);
      expect(one.failedGates.map((gate) => gate.spec)).toContain('frameType');
      expect(one.score).toBeLessThan(NEAR_MISS_SCORE);
      expect(one.outcome).toBe('not_found');
    }
  });
});

describe('§11.3 rate 2 — true matches that auto-attach', () => {
  /**
   * 3 of 8, against a target of 70%. Pinned exactly rather than asserted as a
   * percentage, because the five that miss are two distinct phenomena and only
   * one of them is arguably a defect:
   *
   * - c014–c017 are "MACINA LYCAN 771 GLORIOUS Di2" against "MACINA LYCAN 771
   *   Di2". The names are 70 apart and every spec either side publishes agrees,
   *   so nothing but a person or the LLM can tell whether GLORIOUS is a colour
   *   word or a trim. `ask_llm` is the designed answer to exactly this, not a
   *   failure — and the last describe block shows no threshold reaches them
   *   without also attaching four pairs the reviewer called different.
   * - c003 is the disputed label: see the rate 3 block.
   */
  it('auto-attaches three of the eight, and misses five', () => {
    const attached = trueMatches().filter((one) => one.outcome === 'attach');
    const missed = trueMatches().filter((one) => one.outcome !== 'attach');

    expect(pin(attached)).toEqual([
      'c001 94 speedbike:773 l lycan macina :: speedbike:773 lycan macina',
      'c005 90 speedbike:8973 kapoho l macina :: speedbike:8973 kapoho macina',
      'c007 88 ebikeshop:810 belt city macina :: ebikeshop:810 belt city macina tr',
    ]);
    expect(missed.map((one) => one.slug)).toEqual([
      'c003',
      'c014',
      'c015',
      'c016',
      'c017',
    ]);
  });

  it('keeps every frame *size* the reviewer called one bike', () => {
    // The three that do attach are all one bike in two frame sizes, which the
    // reviewer confirmed on c001 in their own words. These are the pairs the
    // catalog specs used to pin as "known false attaches" — the labelled set is
    // what proves they are correct merges.
    const sizes = ['c001', 'c005', 'c007'];

    for (const slug of sizes) {
      const one = LABELLED_CASES.find((c) => c.slug === slug);
      if (!one) throw new Error(`no case ${slug}`);
      expect(one.verdict).toBe('same');
      expect(one.failedGates).toEqual([]);
      expect(one.score).toBeGreaterThanOrEqual(ACCEPT_SCORE);
      expect(one.outcome).toBe('attach');
    }
  });

  it('sends the GLORIOUS builds to the LLM rather than guessing', () => {
    const glorious = ['c014', 'c015', 'c016', 'c017'].map((slug) => {
      const one = LABELLED_CASES.find((c) => c.slug === slug);
      if (!one) throw new Error(`no case ${slug}`);
      return one;
    });

    for (const one of glorious) {
      expect(one.a.nameKey).toContain('glorious');
      expect(one.b.nameKey).not.toContain('glorious');
      expect(one.failedGates).toEqual([]);
      expect(one.score).toBe(NEAR_MISS_SCORE);
      expect(one.outcome).toBe('ask_llm');
    }
  });
});

describe('§11.3 rate 3 — true matches reaching NEAR_MISS_SCORE', () => {
  /**
   * 7 of 8, against a target of 95%. The single miss is c003, and it is the one
   * label in the set that is disputed rather than simply hard:
   *
   * The reviewer marked "MACINA SPORT SX PRIME0 T-TYPE US46cm" and "…TR56cm"
   * the same bike. US is a step-through frame (Alacsony) and TR a Trapéz, and
   * on four other cases — c002, c006, c008, c011 — the same reviewer wrote that
   * a different frame shape makes a different product. They were also shown a
   * score of 93 with no frame difference visible, because the shapes had not
   * been extracted yet; and they skipped c004, the identical comparison, as
   * uncomparable. So the verdict was formed on evidence that has since been
   * corrected.
   *
   * The label is kept exactly as given — flipping a reviewer's verdict because
   * the engine disagrees is how a labelled set stops meaning anything. It is
   * pinned here instead, so the disagreement is visible rather than averaged
   * away, and so re-reviewing it is a one-line change.
   */
  it('reaches NEAR_MISS_SCORE on seven of the eight', () => {
    const reached = trueMatches().filter((one) => one.score >= NEAR_MISS_SCORE);
    const short = trueMatches().filter((one) => one.score < NEAR_MISS_SCORE);

    expect(reached).toHaveLength(7);
    expect(pin(short)).toEqual([
      'c003 63 ebikeshop:macina prime0 sport sx t-type :: ebikeshop:macina prime0 sport sx t-type tr',
    ]);
  });

  it('is only the disputed frame-shape label that falls short', () => {
    const c003 = LABELLED_CASES.find((one) => one.slug === 'c003');
    if (!c003) throw new Error('no case c003');

    expect(c003.verdict).toBe('same');
    expect(c003.a.specs?.['frameType']).toBe('Alacsony');
    expect(c003.b.specs?.['frameType']).toBe('Trapéz');
    expect(c003.failedGates).toEqual([
      expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'frameType' }),
    ]);
    // What they were shown before the shapes were extracted, and what the same
    // pair scores now.
    expect(c003.scoreAtReview).toBe(93);
    expect(c003.score).toBe(63);
  });
});

describe('§11.3 — recall misses', () => {
  it('never lost a true match before scoring could see it', () => {
    // Every pair the reviewer called one bike is above pg_trgm's threshold, so
    // recall would have offered all eight. This is the evidence the plan asked
    // for on the embedding fallback: on this set it would have found nothing
    // the trigram did not.
    const missed = trueMatches().filter((one) => !one.foundByRecall);

    expect(pin(missed)).toEqual([]);
  });
});

describe('4.6 — the gates, judged against the labels', () => {
  it('never blocks a true match with a gate other than the disputed one', () => {
    // No verdict of "same" is held back by modelNumberMismatch or by any
    // matcher spec. The only gate that fires on a true match at all is the
    // frameType one on c003, which is the disputed label.
    const blocked = trueMatches().filter((one) => one.failedGates.length > 0);

    expect(blocked.map((one) => `${one.slug} ${one.failedGates[0].gate}`)).toEqual([
      'c003 primarySpecMismatch',
    ]);
  });

  it('says nothing either way about the modelNumberMismatch gate', () => {
    // It fires on no labelled case at all, because the model-number bucket was
    // left unreviewed on purpose — a pair a model number apart is settled by a
    // rule, so labelling it would only have added cases every engine gets
    // right. So this set is not the evidence for keeping the gate; the evidence
    // is in `case1-same-shop-variants`, where "771 di2 glorious lycan macina"
    // and "772 …" are one character apart and nothing else stops them. What
    // this set does show is that the gate costs nothing: it blocks no pair a
    // person called one bike.
    const fired = LABELLED_CASES.filter((one) =>
      one.failedGates.some((gate) => gate.gate === 'modelNumberMismatch'),
    );

    expect(fired).toEqual([]);
  });
});

describe('why the two rates fall short, and why no constant fixes it', () => {
  it('overlaps: a different bike outscores a true match', () => {
    // The whole calibration question in one assertion. The best "different"
    // pair scores 79 and the four GLORIOUS true matches score 70, so no accept
    // threshold separates them — any bar low enough to attach the true matches
    // attaches four different bikes first.
    const bestDifferent = Math.max(...differentPairs().map((one) => one.score));
    const missedTrue = trueMatches()
      .filter((one) => one.outcome !== 'attach' && one.score >= NEAR_MISS_SCORE)
      .map((one) => one.score);

    expect(bestDifferent).toBe(79);
    expect(missedTrue).toEqual([70, 70, 70, 70]);
    expect(Math.max(...missedTrue)).toBeLessThan(bestDifferent);
  });

  it('would attach four different bikes if ACCEPT_SCORE dropped to catch them', () => {
    const wouldAttach = differentPairs().filter(
      (one) => one.score >= NEAR_MISS_SCORE && one.failedGates.length === 0,
    );

    expect(pin(wouldAttach)).toEqual([
      'c009 79 ebikeshop:di2 macina master scarp sx :: ebikeshop:di2 macina prestige scarp sx',
      'c010 79 ebikeshop:di2 macina master scarp sx :: ebikeshop:di2 macina prestige scarp sx',
      'c012 73 speedbike:kapoho macina master :: ebikeshop:kapoho macina prestige',
      'c013 73 ebikeshop:kapoho macina master :: ebikeshop:kapoho macina prestige',
    ]);
  });

  it('spends the LLM on four different pairs and four true ones', () => {
    // What the review band actually costs: eight calls over 42 hard cases,
    // evenly split between pairs the LLM should reject and pairs it should
    // accept. That is the band doing its job, not leaking.
    const toLlm = labelledCases().filter((one) => one.outcome === 'ask_llm');

    expect(toLlm.filter((one) => one.verdict === 'different')).toHaveLength(4);
    expect(toLlm.filter((one) => one.verdict === 'same')).toHaveLength(4);
  });

  it('agrees with the reviewer on 36 of the 42 usable cases', () => {
    const agreed = labelledCases().filter((one) =>
      one.verdict === 'same' ? one.outcome === 'attach' : one.outcome !== 'attach',
    );

    // 36 outright, plus the four GLORIOUS pairs the LLM is asked about and the
    // disputed c003 — no case where the engine attaches a different bike.
    expect(agreed).toHaveLength(37);
    expect(
      labelledCases().filter(
        (one) => one.verdict === 'different' && one.outcome === 'attach',
      ),
    ).toEqual([]);
  });
});
