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

describe('§11.3 rate 2 — true matches worded differently go to review', () => {
  /**
   * Only an equal normalizedModel attaches (decideListingMatch), and every true
   * match in this set is two wordings of one bike: a size letter one listing
   * kept ("773 l"), a frame token ("tr"), a colourway ("glorious"). So none
   * attaches on its own any more — the old score rule attached seven — and all
   * seven reach review instead: the LLM when it is on, a duplicate pair for a
   * person while it is off. The single miss is c003, the disputed label; see
   * rate 3.
   *
   * These keys come from the old model rule. Under the current one a size
   * letter and a colourway stay out of the model, so most of these listings
   * would share a key and attach.
   */
  it('sends seven of the eight to review, and creates one', () => {
    const attached = trueMatches().filter((one) => one.outcome === 'attach');
    const reviewed = trueMatches().filter((one) => one.outcome === 'ask_llm');

    expect(pin(attached)).toEqual([]);
    expect(pin(reviewed)).toEqual([
      'c001 85 speedbike:773 l lycan macina :: speedbike:773 lycan macina',
      'c005 84 speedbike:8973 kapoho l macina :: speedbike:8973 kapoho macina',
      'c007 86 ebikeshop:810 belt city macina :: ebikeshop:810 belt city macina tr',
      'c014 81 speedbike:771 di2 glorious lycan macina :: speedbike:771 di2 lycan macina',
      'c015 81 speedbike:771 di2 glorious lycan macina :: speedbike:771 di2 lycan macina',
      'c016 81 speedbike:771 di2 glorious lycan macina :: speedbike:771 di2 lycan macina',
      'c017 81 speedbike:772 di2 glorious lycan macina :: speedbike:772 di2 lycan macina',
    ]);
    expect(trueMatches().filter((one) => one.outcome === 'not_found').map((one) => one.slug)).toEqual([
      'c003',
    ]);
  });

  it('puts every frame *size* the reviewer called one bike in front of a person', () => {
    // One bike in two frame sizes, which the reviewer confirmed on c001 in
    // their own words. Nothing contradicts and the names score high; only
    // their keys differ.
    for (const slug of ['c001', 'c005', 'c007']) {
      const one = caseOf(slug);

      expect(one.verdict).toBe('same');
      expect(one.failedGates).toEqual([]);
      expect(one.score).toBeGreaterThanOrEqual(ACCEPT_SCORE);
      expect(one.outcome).toBe('ask_llm');
    }
  });

  it('puts the GLORIOUS builds in front of a person, the omission scoring above the bar', () => {
    // "MACINA LYCAN 771 GLORIOUS Di2" against "MACINA LYCAN 771 Di2" — the
    // same shop, the same colourway, the same bike, extracted twice with
    // GLORIOUS kept once and stripped once. One name omits a token the other
    // has; neither says something the other contradicts, so the alignment
    // similarity still scores it above ACCEPT_SCORE, where a substitution
    // (Master against Prestige) stays below NEAR_MISS_SCORE.
    for (const slug of ['c014', 'c015', 'c016', 'c017']) {
      const one = caseOf(slug);

      expect(one.a.nameKey).toContain('glorious');
      expect(one.b.nameKey).not.toContain('glorious');
      expect(one.failedGates).toEqual([]);
      expect(one.score).toBeGreaterThanOrEqual(ACCEPT_SCORE);
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
   * assertions are where it shows up first. Under the key rule the score no
   * longer attaches anything; it decides what reaches review, so the
   * separation now guards that.
   */
  it('separates the classes outright: every true match in review outscores every different bike', () => {
    // The old scorer had the best "different" pair at 79 and four true matches
    // at 70 — inverted. Now the worst true match in review clears the best
    // different pair by 13.
    const bestDifferent = Math.max(...differentPairs().map((one) => one.score));
    const reviewed = trueMatches()
      .filter((one) => one.outcome === 'ask_llm')
      .map((one) => one.score);

    expect(bestDifferent).toBe(68);
    expect(Math.min(...reviewed)).toBe(81);
    expect(Math.min(...reviewed) - bestDifferent).toBeGreaterThanOrEqual(12);
  });

  it('would still put no different bike in review at NEAR_MISS_SCORE', () => {
    // The old scorer had four different bikes waiting just under the bar
    // (c009, c010, c012, c013). None of them is within reach now.
    const wouldReview = differentPairs().filter(
      (one) => one.score >= NEAR_MISS_SCORE,
    );

    expect(pin(wouldReview)).toEqual([]);
  });

  it('sends review exactly the true matches, and no different bike', () => {
    // The review band is what a differently worded listing of one bike now
    // reaches; on the hardest 42 pairs anyone has labelled, it holds those and
    // nothing else.
    const toReview = labelledCases().filter((one) => one.outcome === 'ask_llm');

    expect(toReview.map((one) => one.slug)).toEqual([
      'c001',
      'c005',
      'c007',
      'c014',
      'c015',
      'c016',
      'c017',
    ]);
    expect(toReview.every((one) => one.verdict === 'same')).toBe(true);
  });

  it('agrees with the reviewer on 41 of the 42 usable cases', () => {
    // A true match agrees when it attaches or reaches review; a different bike
    // when it does neither.
    const agreed = labelledCases().filter((one) =>
      one.verdict === 'same' ? one.outcome !== 'not_found' : one.outcome === 'not_found',
    );

    // The one disagreement is c003, the disputed label.
    expect(agreed).toHaveLength(41);
    expect(
      labelledCases()
        .filter((one) => one.verdict === 'same' && one.outcome === 'not_found')
        .map((one) => one.slug),
    ).toEqual(['c003']);
    expect(
      labelledCases().filter(
        (one) => one.verdict === 'different' && one.outcome !== 'not_found',
      ),
    ).toEqual([]);
  });
});
