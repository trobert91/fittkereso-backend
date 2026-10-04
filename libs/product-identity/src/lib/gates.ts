import type {
  IdentityGate,
  ProductCategoryConfig,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { clamp, compact, isEmpty, isNil, sumBy, uniq } from 'lodash';
import { GATE_SEVERITY } from './product-identity.constants';
import { compareSpecValue, type SpecValue } from './spec-values';
import type { FailedGate } from './types';

export interface GateInput {
  /** The query's model as written (else its title), for the model-number check. */
  queryModel: string;
  /** The candidate listing's model as written. */
  candidateModel: string;
  querySpecs?: ProductSpecs;
  candidateSpecs?: ProductSpecs;
  /** Supplies the spec lists, compatible values and tolerances. */
  categoryConfig?: ProductCategoryConfig;
}

/**
 * Every contradiction between a query and a candidate: primary specs, specs
 * only one side states, model numbers, then matcher specs. A value missing on
 * either side skips its mismatch gate — it costs something only for a spec
 * the category's `matchingConfig.missingSpecPenalty` names, and only when the
 * other side states it. No gate rejects on its own: each only lowers the score
 * (scoreOf).
 *
 * Spec gates compare only the category's `primarySpecs` and `matcherSpecs`; a
 * key in both lists is primary. A category with neither has no spec gates. A
 * spec gate costs its GATE_SEVERITY unless the category's
 * `matchingConfig.specMismatchPenalty` sets that spec's own points.
 */
export function applyGates(input: GateInput): FailedGate[] {
  const primarySpecs = uniq(input.categoryConfig?.primarySpecs ?? []);
  const matcherSpecs = uniq(input.categoryConfig?.matcherSpecs ?? []).filter(
    (key) => !primarySpecs.includes(key),
  );

  return compact([
    ...primarySpecs.map((key) => specGate('primarySpecMismatch', key, input)),
    ...missingSpecGates(input),
    modelNumberGate(input.queryModel, input.candidateModel),
    ...matcherSpecs.map((key) => specGate('matcherSpecMismatch', key, input)),
  ]);
}

/**
 * Only the primary-spec gates: the contradictions that make two things
 * different products however their names compare. For a candidate an
 * identifier already found — the names are not in question there, and the
 * model-number gate would read a size written into one shop's title ("L/48")
 * as a different model.
 */
export function primarySpecMismatches(
  input: Omit<GateInput, 'queryModel' | 'candidateModel'>,
): FailedGate[] {
  return compact(
    uniq(input.categoryConfig?.primarySpecs ?? []).map((key) =>
      specGate('primarySpecMismatch', key, input),
    ),
  );
}

/** A base score minus every failed gate's severity, kept within 1–100. */
export function scoreOf(baseScore: number, failedGates: FailedGate[]): number {
  return clamp(baseScore - sumBy(failedGates, (gate) => gate.severity), 1, 100);
}

/**
 * 100 minus the spec gates alone — primary, missing and matcher specs — for a
 * candidate whose normalizedModel equals the query's. The name is not in
 * question there, and equal keys already carry equal model numbers, so the
 * model-number gate would only read a size one shop wrote into its title.
 */
export function keyScoreOf(failedGates: FailedGate[]): number {
  return scoreOf(
    100,
    failedGates.filter((gate) => gate.gate !== 'modelNumberMismatch'),
  );
}

/**
 * Whether a spec carries a value a gate may compare. Beyond null/undefined, an
 * empty string and a zero are absences a scraper wrote down: a label matched
 * with nothing after it, or a number it could not parse. Neither contradicts
 * anything, and a gate that read them as values would subtract for a spec the
 * shop never published.
 *
 * A boolean `false` is a real value and stays one — a bike without ABS genuinely
 * contradicts a bike with it.
 */
function isPresent(value: ProductSpecs[string]): value is SpecValue {
  return !isNil(value) && value !== '' && value !== 0;
}

/**
 * Fires when only one side states a spec the category's
 * `matchingConfig.missingSpecPenalty` names, at that spec's penalty: a listing
 * silent on its model year against last year's product. Neither side stating
 * it costs nothing, so two silent listings of one bike still match each other.
 *
 * Only `applyGates` runs it. A product an identifier found is not in question
 * by name, which is what this guards (see primarySpecMismatches).
 */
function missingSpecGates({
  querySpecs,
  candidateSpecs,
  categoryConfig,
}: GateInput): FailedGate[] {
  const penalties = categoryConfig?.matchingConfig?.missingSpecPenalty ?? {};

  return Object.entries(penalties).flatMap(([key, severity]) => {
    const queryValue = querySpecs?.[key];
    const candidateValue = candidateSpecs?.[key];
    const queryStates = isPresent(queryValue);
    if (severity <= 0 || queryStates === isPresent(candidateValue)) return [];

    return [
      {
        gate: 'specMissing' as const,
        spec: key,
        severity,
        queryValue: queryStates ? (queryValue as SpecValue) : null,
        candidateValue: queryStates ? null : (candidateValue as SpecValue),
      },
    ];
  });
}

type SpecMismatchGate = Extract<
  IdentityGate,
  'primarySpecMismatch' | 'matcherSpecMismatch'
>;

function specGate(
  gate: SpecMismatchGate,
  key: string,
  {
    querySpecs,
    candidateSpecs,
    categoryConfig,
  }: Omit<GateInput, 'queryModel' | 'candidateModel'>,
): FailedGate | undefined {
  const severity = mismatchSeverity(gate, key, categoryConfig);
  if (severity <= 0) return undefined;

  const queryValue = querySpecs?.[key];
  const candidateValue = candidateSpecs?.[key];
  if (!isPresent(queryValue) || !isPresent(candidateValue)) return undefined;

  const result = compareSpecValue(
    queryValue,
    candidateValue,
    categoryConfig?.matchingConfig?.compatibleValues?.[key],
    categoryConfig?.matchingConfig?.specTolerances?.[key],
  );
  if (result !== 'mismatch') return undefined;

  return {
    gate,
    spec: key,
    severity,
    queryValue,
    candidateValue,
  };
}

/**
 * The spec's own points from the category's `matchingConfig.specMismatchPenalty`
 * — a model year apart is proof enough of two products, where a weight apart
 * is not — or the gate's default.
 */
function mismatchSeverity(
  gate: SpecMismatchGate,
  key: string,
  categoryConfig: ProductCategoryConfig | undefined,
): number {
  return (
    categoryConfig?.matchingConfig?.specMismatchPenalty?.[key] ??
    GATE_SEVERITY[gate]
  );
}

/**
 * Fires when both names carry model numbers (words with a digit) and neither
 * name has all of the other's: "Macina Cross 720" vs "Macina Cross 725".
 * One name having all of the other's passes — "Macina Style 810 Di2" vs
 * "Macina Style 810" is one shop printing more of the name. Name similarity
 * alone scores that 720/725 pair 94.
 *
 * Reads the names as written, with letters glued to their digits, because
 * those letters tell models apart: KTM's A510, P510 and CX510 differ only
 * there, and a split key reads all three as "510". A number counts as there
 * when the other name writes it whole or as its letter and digit runs, so
 * "CX830" and "CX 830" agree.
 */
function modelNumberGate(
  queryModel: string,
  candidateModel: string,
): FailedGate | undefined {
  const queryNumbers = modelNumbersOf(queryModel);
  const candidateNumbers = modelNumbersOf(candidateModel);
  if (isEmpty(queryNumbers) || isEmpty(candidateNumbers)) return undefined;

  const queryWords = new Set(writtenWords(queryModel));
  const candidateWords = new Set(writtenWords(candidateModel));
  if (
    queryNumbers.every((number) => isWrittenIn(number, candidateWords)) ||
    candidateNumbers.every((number) => isWrittenIn(number, queryWords))
  ) {
    return undefined;
  }

  return {
    gate: 'modelNumberMismatch',
    severity: GATE_SEVERITY.modelNumberMismatch,
    queryValue: queryNumbers,
    candidateValue: candidateNumbers,
  };
}

/** A name's words as written: lowercased, split on spaces and punctuation, letters and digits kept together. */
function writtenWords(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}+]+/u)
    .filter(Boolean);
}

function modelNumbersOf(name: string): string[] {
  return uniq(writtenWords(name).filter((word) => /\d/.test(word))).sort();
}

/** Whether a model number is in a name's words: whole, or as each of its letter and digit runs. */
function isWrittenIn(number: string, words: Set<string>): boolean {
  if (words.has(number)) return true;
  const runs = number.match(/\p{L}+|\p{N}+/gu) ?? [];
  return runs.length > 0 && runs.every((run) => words.has(run));
}
