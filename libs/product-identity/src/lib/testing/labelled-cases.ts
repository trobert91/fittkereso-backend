import type { ListingMatchChoice } from '../listing-match-decision';
import type { FailedGate, ProductCandidate } from '../types';
import {
  CatalogListing,
  LISTINGS,
  RECALL_THRESHOLD,
  asProduct,
  candidateBetween,
  gatesOf,
  outcomeOf,
  trigramOf,
} from './catalog';
import labelled from './labelled-cases.json';

/**
 * The labelled pair set of §11.2 — what a **person** decided about 43 pairs the
 * engine found hard, reviewed on 2026-09-16 against both shops' live pages.
 *
 * This is the one thing `catalog.json` cannot be. The catalog's "labels" are
 * whatever the old matcher settled on, so rates computed against it only say
 * how well the new engine imitates the old one. These verdicts were given by
 * the user, case by case, with both listings' specs and both shop pages open.
 *
 * The 43 are not a random sample: they are the two buckets where the answer was
 * genuinely unclear — 9 pairs separated only by a frame token, and 34 separated
 * by some other naming difference. The buckets that a stated rule already
 * decides (identical names, a model year apart, a model number apart, a build
 * variant) were left unreviewed on purpose, because labelling them would only
 * have added cases every version of the engine gets right and flattered every
 * rate below. That is why the denominators here are small: they are the hard
 * cases only.
 *
 * Sides are stored as catalog listing ids, with the shop and name key alongside
 * so the file reads on its own and so `caseOf` can refuse to run against a
 * catalog that has moved underneath it.
 */
export type Verdict = 'same' | 'different' | 'skipped';

interface LabelledSide {
  id: string;
  shop: string;
  nameKey: string;
}

interface LabelledRecord {
  slug: string;
  verdict: string;
  rule: string;
  scoreAtReview: number;
  note?: string;
  a: LabelledSide;
  b: LabelledSide;
}

export interface LabelledCase {
  slug: string;
  /** What the reviewer decided. `skipped` means they could not tell. */
  verdict: Verdict;
  /** The bucket the case was drawn from. */
  rule: string;
  /** The score the reviewer was shown, before the frameType repair. */
  scoreAtReview: number;
  /** The reviewer's own words, where they wrote any. */
  note?: string;
  a: CatalogListing;
  b: CatalogListing;
  /** What the engine scores this pair at today. */
  score: number;
  failedGates: FailedGate[];
  /** What a scrape of `a` would do against a product built from `b`. */
  outcome: ListingMatchChoice<ProductCandidate>['kind'];
  /** False when the trigram is too low for recall to have offered the pair at all. */
  foundByRecall: boolean;
}

const BY_ID = new Map(LISTINGS.map((row) => [row.id, row]));

function sideOf(slug: string, side: LabelledSide): CatalogListing {
  const row = BY_ID.get(side.id);
  if (!row) {
    throw new Error(`${slug}: no catalog listing ${side.id} (${side.nameKey})`);
  }
  if (row.shop !== side.shop || row.nameKey !== side.nameKey) {
    throw new Error(
      `${slug}: listing ${side.id} is now ${row.shop}:"${row.nameKey}", ` +
        `labelled as ${side.shop}:"${side.nameKey}" — relabel or re-export`,
    );
  }
  return row;
}

function caseOf(record: LabelledRecord): LabelledCase {
  const a = sideOf(record.slug, record.a);
  const b = sideOf(record.slug, record.b);
  const candidate = candidateBetween(a, asProduct(b));

  return {
    slug: record.slug,
    verdict: record.verdict as Verdict,
    rule: record.rule,
    scoreAtReview: record.scoreAtReview,
    ...(record.note ? { note: record.note } : {}),
    a,
    b,
    score: candidate.score,
    failedGates: gatesOf(a, b),
    outcome: outcomeOf(a, asProduct(b)),
    foundByRecall: trigramOf(a.nameKey, b.nameKey) >= RECALL_THRESHOLD,
  };
}

/** When the reviewer gave their verdicts. */
export const REVIEWED_AT = labelled.reviewedAt;

/** Every reviewed case, including the ones the reviewer skipped. */
export const LABELLED_CASES: LabelledCase[] = (
  labelled.cases as LabelledRecord[]
).map(caseOf);

/** The cases that carry a usable label — everything the reviewer did not skip. */
export function labelledCases(): LabelledCase[] {
  return LABELLED_CASES.filter((one) => one.verdict !== 'skipped');
}

/** Pairs the reviewer said are one bike. */
export function trueMatches(): LabelledCase[] {
  return LABELLED_CASES.filter((one) => one.verdict === 'same');
}

/** Pairs the reviewer said are two different bikes. */
export function differentPairs(): LabelledCase[] {
  return LABELLED_CASES.filter((one) => one.verdict === 'different');
}

/** `ebikeshop:810 belt city macina :: ebikeshop:810 belt city macina tr` */
export function describeCase(one: LabelledCase): string {
  return `${one.a.shop}:${one.a.nameKey} :: ${one.b.shop}:${one.b.nameKey}`;
}
