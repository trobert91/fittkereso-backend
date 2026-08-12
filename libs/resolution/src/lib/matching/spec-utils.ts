import {
  OrderedSpec,
  ProductSpecs,
  StructuredSpec,
} from '@fittkereso-backend/database';
import { isNil, isEmpty } from 'lodash';

/**
 * Returns true when the specs record is nil or has no keys with defined values.
 */
export function isSpecsEmpty(specs: ProductSpecs | undefined): boolean {
  if (!specs) return true;
  return Object.keys(specs).every((key) => isNil(specs[key]));
}

/**
 * Memoized `structuredSpecsToProductSpecs(context.input.specs)`. The input is
 * frozen per resolution, so the conversion is computed once and cached on the
 * context for stages that need the input specs as a map (scoring, etc.).
 *
 * Typed structurally to avoid a model↔util import cycle.
 */
export function getInputSpecsMap(context: {
  input: { specs?: StructuredSpec[] };
  inputSpecsMap?: ProductSpecs;
}): ProductSpecs {
  if (context.inputSpecsMap) return context.inputSpecsMap;
  const map = structuredSpecsToProductSpecs(context.input.specs);
  context.inputSpecsMap = map;
  return map;
}

/**
 * Convert StructuredSpec[] (LLM extraction output) into a ProductSpecs record.
 * Values remain as strings — the SpecComparisonService handles type coercion internally.
 */
export function structuredSpecsToProductSpecs(
  specs: StructuredSpec[] | undefined,
): ProductSpecs {
  if (!specs || isEmpty(specs)) return {};

  const result: ProductSpecs = {};
  for (const spec of specs) {
    result[spec.name] = spec.value;
  }
  return result;
}

/**
 * Convert a ProductSpecs record into the StructuredSpec[] format used by the resolution pipeline.
 * Skips entries where the value is nil or an empty string.
 * Array values are joined with ", " so they fit the single-string StructuredSpec contract.
 */
export function productSpecsToStructuredSpecs(
  specs: ProductSpecs | undefined,
): StructuredSpec[] {
  if (!specs) return [];

  const result: StructuredSpec[] = [];

  for (const [key, value] of Object.entries(specs)) {
    if (isNil(value)) continue;

    let stringValue: string;
    if (Array.isArray(value)) {
      stringValue = value.join(', ');
    } else if (typeof value === 'boolean') {
      stringValue = value ? 'yes' : 'no';
    } else {
      stringValue = String(value);
    }

    if (stringValue === '') continue;

    result.push({ name: key, value: stringValue });
  }

  return result;
}

/**
 * Produce a short human-readable summary from ProductSpecs for use in LLM prompts.
 * Prioritizes well-known keys (screenSize, panelType, resolution) and caps output
 * at `maxItems` entries. Each entry is rendered as `"key:value"`.
 */
export function productSpecsSummary(
  specs: ProductSpecs | undefined,
  maxItems = 4,
): string[] {
  if (!specs || isSpecsEmpty(specs)) return [];

  const priorityKeys = ['screenSize', 'panelType', 'resolution'];
  const parts: string[] = [];

  for (const key of priorityKeys) {
    if (parts.length >= maxItems) break;
    const value = specs[key];
    if (isNil(value)) continue;
    parts.push(`${key}:${Array.isArray(value) ? value.join(', ') : value}`);
  }

  for (const [key, value] of Object.entries(specs)) {
    if (parts.length >= maxItems) break;
    if (priorityKeys.includes(key) || isNil(value)) continue;
    parts.push(`${key}:${Array.isArray(value) ? value.join(', ') : value}`);
  }

  return parts;
}

/**
 * Convert ProductSpecs into OrderedSpec[] for display and output boundaries.
 * Uses the key as both `key` and `label` since ProductSpecs has no separate label.
 */
export function productSpecsToOrderedSpecs(
  specs: ProductSpecs | undefined,
): OrderedSpec[] {
  if (!specs) return [];

  const result: OrderedSpec[] = [];

  for (const [key, value] of Object.entries(specs)) {
    if (isNil(value)) continue;
    result.push({ key, label: key, value });
  }

  return result;
}
