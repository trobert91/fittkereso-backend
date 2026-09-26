import { get } from 'lodash';
import {
  FilterJsonArrayOp,
  FlattenJsonArrayOp,
  MapJsonArrayOp,
  ParseJsonAttrOp,
} from '@fittkereso-backend/database';
import { OpHandler } from '../services/scrape-op-registry.service';
import { interpolate } from '../services/interpolation.util';

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: '&',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

// Some hydration payloads (e.g. server-rendered Vue/Inertia apps) HTML-encode
// string values a second time before embedding them in the JSON blob — so
// even after JSON.parse, a value like a model name can still contain literal
// `&#39;` / `&amp;` sequences. Cheerio's own attr() decode only unwraps the
// outer layer (enough to make the attribute valid JSON); this unwraps what's
// left inside the parsed string values.
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const num = parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function decodeEntitiesDeep(value: unknown): unknown {
  if (typeof value === 'string') return decodeEntities(value);
  if (Array.isArray(value)) return value.map(decodeEntitiesDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, decodeEntitiesDeep(v)]),
    );
  }
  return value;
}

export const parseJsonAttr: OpHandler<ParseJsonAttrOp> = (ctx, _input, op) => {
  const selection = op.first
    ? ctx.$(op.selector).first()
    : ctx.$(op.selector);
  const raw = selection.attr(op.attr);
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const value = op.path ? get(parsed, op.path) : parsed;
  return indexedObjectsToArrays(decodeEntitiesDeep(value));
};

const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

/**
 * PHP's json_encode writes an array whose keys are not exactly 0…n-1 (say,
 * after a filter dropped rows) as an object keyed "0", "1", "15"…. Laravel
 * does this to paginated collections, so a listing read as `props.products`
 * can arrive as an object, and every array op would then see no items at all.
 *
 * This turns any plain object whose keys are all array indices back into an
 * array, in key order (the order JS enumerates integer keys), recursively.
 * The ops resolve their own `path` first, so a path such as `products.15`
 * still addresses the raw key.
 */
export function indexedObjectsToArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(indexedObjectsToArrays);
  if (!isPlainObject(value)) return value;

  const entries = Object.entries(value).map(
    ([key, inner]) => [key, indexedObjectsToArrays(inner)] as const,
  );
  if (entries.length > 0 && entries.every(([key]) => ARRAY_INDEX.test(key))) {
    return entries.map(([, inner]) => inner);
  }
  return Object.fromEntries(entries);
}

// Only what JSON.parse builds: a cheerio selection is array-like too, with
// keys "0"…"n", and must pass through untouched.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Projects each item of an array (previously stashed in `vars` via a prior
// op's `as`) into a plain object using dot-paths per output field, with
// optional `{{field}}` template interpolation scoped to that item (e.g.
// combining a value and its unit into one string).
export const mapJsonArray: OpHandler<MapJsonArrayOp> = (ctx, input, op) => {
  if (!Array.isArray(input)) return [];

  const mapped = input.map((item) => {
    const result: Record<string, unknown> = {};
    for (const [key, fieldSpec] of Object.entries(op.fields)) {
      let value: unknown = get(item, fieldSpec.path);
      if (fieldSpec.template) {
        const itemCtx = { ...ctx, vars: { ...ctx.vars, ...toRecord(item) } };
        value = interpolate(fieldSpec.template, itemCtx).trim();
      }
      result[key] = fieldSpec.asArray ? [value] : value;
    }
    return result;
  });

  const flattenField = op.flattenField;
  return flattenField ? mapped.map((item) => item[flattenField]) : mapped;
};

function toRecord(item: unknown): Record<string, unknown> {
  return item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
}

export const filterJsonArray: OpHandler<FilterJsonArrayOp> = (
  _ctx,
  input,
  op,
) => {
  if (!Array.isArray(input)) return [];

  return input.filter((item) => {
    const matches = get(item, op.path) === op.equals;
    return op.negate ? !matches : matches;
  });
};

export const flattenJsonArray: OpHandler<FlattenJsonArrayOp> = (
  _ctx,
  input,
  op,
) => {
  if (!Array.isArray(input)) return [];

  return input.flatMap((item) => {
    const inner = get(item, op.path);
    return Array.isArray(inner) ? inner : [];
  });
};
