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
  queryKey: string;
  candidateKey: string;
  querySpecs?: ProductSpecs;
  candidateSpecs?: ProductSpecs;
  /** Supplies the spec lists, hierarchies and tolerances. */
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
 * key in both lists is primary. A category with neither has no spec gates.
 */
export function applyGates(input: GateInput): FailedGate[] {
  const primarySpecs = uniq(input.categoryConfig?.primarySpecs ?? []);
  const matcherSpecs = uniq(input.categoryConfig?.matcherSpecs ?? []).filter(
    (key) => !primarySpecs.includes(key),
  );

  return compact([
    ...primarySpecs.map((key) => specGate('primarySpecMismatch', key, input)),
    ...missingSpecGates(input),
    modelNumberGate(input.queryKey, input.candidateKey),
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
  input: Omit<GateInput, 'queryKey' | 'candidateKey'>,
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

function specGate(
  gate: Exclude<IdentityGate, 'specMissing'>,
  key: string,
  {
    querySpecs,
    candidateSpecs,
    categoryConfig,
  }: Omit<GateInput, 'queryKey' | 'candidateKey'>,
): FailedGate | undefined {
  const queryValue = querySpecs?.[key];
  const candidateValue = candidateSpecs?.[key];
  if (!isPresent(queryValue) || !isPresent(candidateValue)) return undefined;

  const result = compareSpecValue(
    queryValue,
    candidateValue,
    categoryConfig?.matcherSpecHierarchies?.[key],
    categoryConfig?.matchingConfig?.specTolerances?.[key],
  );
  if (result !== 'mismatch') return undefined;

  return {
    gate,
    spec: key,
    severity: GATE_SEVERITY[gate],
    queryValue,
    candidateValue,
  };
}

/**
 * Fires when both keys carry model numbers (words containing a digit) and
 * neither set contains the other: "720 cross macina" vs "725 cross macina".
 * A subset passes — "2024 720 cross macina" vs "720 cross macina" is one shop
 * printing more of the name. Name similarity alone scores that 720/725 pair
 * 94, which would auto-attach.
 */
function modelNumberGate(
  queryKey: string,
  candidateKey: string,
): FailedGate | undefined {
  const queryNumbers = modelNumbersOf(queryKey);
  const candidateNumbers = modelNumbersOf(candidateKey);
  if (isEmpty(queryNumbers) || isEmpty(candidateNumbers)) return undefined;

  const isSubset = (small: string[], large: string[]) =>
    small.every((word) => large.includes(word));
  if (
    isSubset(queryNumbers, candidateNumbers) ||
    isSubset(candidateNumbers, queryNumbers)
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

function modelNumbersOf(key: string): string[] {
  return uniq(key.split(/\s+/).filter((word) => /\d/.test(word))).sort();
}
