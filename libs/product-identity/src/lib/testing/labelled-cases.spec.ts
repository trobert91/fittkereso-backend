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
 * `labelled-cases.ts`). So a rate here is a rate over hard cases only.
 *
 * **Re-measured when `baseScore` became a blend.** Under the old
 * `max(trigram, levenshtein)` these numbers were 3 of 8 auto-attaching against
 * a 70% target, and the last describe block was the evidence that no choice of
 * constants would ever reach it: the best "different" pair scored 79 and four
 * true matches scored 70, so every threshold that caught the true matches
 * caught four different bikes first. That overlap is what the blend removed —
 * it is the one measurement that justifies the change, and the last block now
 * records the separation instead of the overlap.
 *
 * The two safety assertions, which are the ones that gate the scraper switch,
 * are still met outright and with more room than before: nothing the reviewer
 * called a different bike auto-attaches, and nothing they called a different
 * bike comes within twelve points of ACCEPT_SCORE.
 */
function pin(cases: LabelledCase[]): string[] {
  return cases.map((one) => `${one.slug} ${one.score} ${describeCase(one)}`);
}

function caseOf(slug: string): LabelledCase {
  const one = LABELLED_CASES.find((c) => c.slug === slug);
  if (!one) throw new Error(`no case ${slug}`);
  return one;
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

  it('and none of them comes close to ACCEPT_SCORE', () => {
    // §11.3's fourth assertion. The highest a "different" pair reaches is 68 —
    // c009 and c010, the Master against the Prestige, which the old scorer put
    // at 79, one point under the bar. Twelve points of headroom instead of one.
    const reaching = differentPairs().filter((one) => one.score >= ACCEPT_SCORE);

    expect(pin(reaching)).toEqual([]);
    expect(Math.max(...differentPairs().map((one) => one.score))).toBe(68);
  });

  it('separates every frame shape the reviewer called a different bike', () => {
    // The four cases the reviewer annotated in their own words — "different
    // frameTypes, different products". Each was a false attach or a near miss
    // when they reviewed it, because ebikeshop's Váztípus never reached
    // frameType; all four gate on it now.
    for (const slug of ['c002', 'c006', 'c008', 'c011']) {
      const one = caseOf(slug);

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
   * 7 of 8, against a target of 70% — met, where the old scorer reached 3.
   * Pinned exactly rather than as a percentage so the four that moved stay
   * visible: c014–c017 are the GLORIOUS builds, and they are the whole reason
   * the alignment similarity exists. See the block below.
   *
   * The single remaining miss is c003, the disputed label; see rate 3.
   */
  it('auto-attaches seven of the eight, and misses one', () => {
    const attached = trueMatches().filter((one) => one.outcome === 'attach');
    const missed = trueMatches().filter((one) => one.outcome !== 'attach');

    expect(pin(attached)).toEqual([
      'c001 85 speedbike:773 l lycan macina :: speedbike:773 lycan macina',
      'c005 84 speedbike:8973 kapoho l macina :: speedbike:8973 kapoho macina',
      'c007 86 ebikeshop:810 belt city macina :: ebikeshop:810 belt city macina tr',
      'c014 81 speedbike:771 di2 glorious lycan macina :: speedbike:771 di2 lycan macina',
      'c015 81 speedbike:771 di2 glorious lycan macina :: speedbike:771 di2 lycan macina',
      'c016 81 speedbike:771 di2 glorious lycan macina :: speedbike:771 di2 lycan macina',
      'c017 81 speedbike:772 di2 glorious lycan macina :: speedbike:772 di2 lycan macina',
    ]);
    expect(missed.map((one) => one.slug)).toEqual(['c003']);
  });

  it('keeps every frame *size* the reviewer called one bike', () => {
    // One bike in two frame sizes, which the reviewer confirmed on c001 in
    // their own words. These are the pairs the catalog specs used to pin as
    // "known false attaches" — the labelled set is what proves they are
    // correct merges.
    for (const slug of ['c001', 'c005', 'c007']) {
      const one = caseOf(slug);

      expect(one.verdict).toBe('same');
      expect(one.failedGates).toEqual([]);
      expect(one.score).toBeGreaterThanOrEqual(ACCEPT_SCORE);
      expect(one.outcome).toBe('attach');
    }
  });

  it('attaches the GLORIOUS builds instead of paying the LLM to decide', () => {
    // "MACINA LYCAN 771 GLORIOUS Di2" against "MACINA LYCAN 771 Di2" — the
    // same shop, the same colourway, the same bike, extracted twice with
    // GLORIOUS kept once and stripped once. One name omits a token the other
    // has; neither says something the other contradicts.
    //
    // This is exactly what the alignment similarity is for, and it is the one
    // case in the set where the old scorer had no answer: it scored all four
    // at 70 on the strength of the character difference alone, the same band
    // it put the Master/Prestige pairs in at 79 — a substitution, and a
    // different bike. An omission now scores well above a substitution, so
    // these attach and those do not.
    for (const slug of ['c014', 'c015', 'c016', 'c017']) {
      const one = caseOf(slug);

      expect(one.a.nameKey).toContain('glorious');
      expect(one.b.nameKey).not.toContain('glorious');
      expect(one.failedGates).toEqual([]);
      expect(one.score).toBeGreaterThanOrEqual(ACCEPT_SCORE);
      expect(one.outcome).toBe('attach');
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
   * away, and so re-reviewing it is a one-line change. It is also the only
   * thing standing between this rate and its 95% target.
   */
  it('reaches NEAR_MISS_SCORE on seven of the eight', () => {
    const reached = trueMatches().filter((one) => one.score >= NEAR_MISS_SCORE);
    const short = trueMatches().filter((one) => one.score < NEAR_MISS_SCORE);

    expect(reached).toHaveLength(7);
    expect(pin(short)).toEqual([
      'c003 58 ebikeshop:macina prime0 sport sx t-type :: ebikeshop:macina prime0 sport sx t-type tr',
    ]);
  });

  it('is only the disputed frame-shape label that falls short', () => {
    const c003 = caseOf('c003');

    expect(c003.verdict).toBe('same');
    expect(c003.a.specs?.['frameType']).toBe('Alacsony');
    expect(c003.b.specs?.['frameType']).toBe('Trapéz');
    expect(c003.failedGates).toEqual([
      expect.objectContaining({ gate: 'primarySpecMismatch', spec: 'frameType' }),
    ]);
    // What they were shown before the shapes were extracted, and what the same
    // pair scores now. The name alone would attach it — a "tr" the other side
    // omits is worth 88 — and the frameType gate is the whole 30-point drop.
    expect(c003.scoreAtReview).toBe(93);
    expect(c003.score).toBe(58);
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

describe('the overlap the blend removed', () => {
  /**
   * This block used to be headed "why the two rates fall short, and why no
   * constant fixes it". It is kept, inverted, because the overlap it recorded
   * is the entire case for blending — if a future change brings it back, these
   * assertions are where it shows up first.
   */
  it('separates the classes outright: every true match outscores every different bike', () => {
    // The old scorer had the best "different" pair at 79 and four true matches
    // at 70 — inverted, and no accept threshold could tell them apart. Now the
    // worst attaching true match clears the best different pair by 13.
    const bestDifferent = Math.max(...differentPairs().map((one) => one.score));
    const attaching = trueMatches()
      .filter((one) => one.outcome === 'attach')
      .map((one) => one.score);

    expect(bestDifferent).toBe(68);
    expect(Math.min(...attaching)).toBe(81);
    expect(Math.min(...attaching) - bestDifferent).toBeGreaterThanOrEqual(12);
  });

  it('would still attach nothing wrong if ACCEPT_SCORE dropped to NEAR_MISS_SCORE', () => {
    // The old scorer had four different bikes waiting just under the bar
    // (c009, c010, c012, c013). None of them is within reach now, so the two
    // thresholds have slack in them rather than sitting on top of the data.
    const wouldAttach = differentPairs().filter(
      (one) => one.score >= NEAR_MISS_SCORE,
    );

    expect(pin(wouldAttach)).toEqual([]);
  });

  it('spends no LLM call at all on these 42 hard cases', () => {
    // The review band cost eight calls before, split evenly between pairs the
    // LLM should reject and pairs it should accept. Both halves now land on the
    // right side of the bar by score alone. The band is not dead — it is what
    // catches the cases this set does not contain — but on the hardest 42 pairs
    // anyone has labelled, it is no longer load-bearing.
    const toLlm = labelledCases().filter((one) => one.outcome === 'ask_llm');

    expect(pin(toLlm)).toEqual([]);
  });

  it('agrees with the reviewer on 41 of the 42 usable cases', () => {
    const agreed = labelledCases().filter((one) =>
      one.verdict === 'same' ? one.outcome === 'attach' : one.outcome !== 'attach',
    );

    // 41, against 37 before. The one disagreement is c003, the disputed label.
    expect(agreed).toHaveLength(41);
    expect(
      labelledCases().filter(
        (one) => one.verdict === 'same' && one.outcome !== 'attach',
      ).map((one) => one.slug),
    ).toEqual(['c003']);
    expect(
      labelledCases().filter(
        (one) => one.verdict === 'different' && one.outcome === 'attach',
      ),
    ).toEqual([]);
  });
});
