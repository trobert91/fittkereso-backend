import type {
  IdentityGate,
  ProductCategoryConfig,
  ProductSpecs,
} from '@fittkereso-backend/database';
import { clamp, compact, isEmpty, isNil, sumBy, uniq } from 'lodash';
import { GATE_SEVERITY } from './product-identity.constants';
import { compareSpecValue } from './spec-values';
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
 * Every contradiction between a query and a candidate: primary specs, model
 * numbers, then matcher specs. A value missing on either side skips its gate,
 * and no gate rejects on its own — each only lowers the score (scoreOf).
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
    modelNumberGate(input.queryKey, input.candidateKey),
    ...matcherSpecs.map((key) => specGate('matcherSpecMismatch', key, input)),
  ]);
}

/** A base score minus every failed gate's severity, kept within 1–100. */
export function scoreOf(baseScore: number, failedGates: FailedGate[]): number {
  return clamp(baseScore - sumBy(failedGates, (gate) => gate.severity), 1, 100);
}

function specGate(
  gate: IdentityGate,
  key: string,
  { querySpecs, candidateSpecs, categoryConfig }: GateInput,
): FailedGate | undefined {
  const queryValue = querySpecs?.[key];
  const candidateValue = candidateSpecs?.[key];
  if (isNil(queryValue) || isNil(candidateValue)) return undefined;

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
