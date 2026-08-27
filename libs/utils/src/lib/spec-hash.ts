import { createHash } from 'crypto';
import { isBoolean, isEmpty, isNumber } from 'lodash';

/**
 * True for a spec value worth keeping: a real boolean/number (including
 * `false`/`0`, which `isEmpty` would otherwise treat as absent since it
 * doesn't special-case primitives), or any other value lodash's `isEmpty`
 * doesn't consider empty (non-blank string, non-empty array/object).
 * `undefined`/`null` — notably including a key a normalization pass mapped
 * but couldn't type-convert, e.g. ProductSpecNormalizationService assigning
 * `result[key] = undefined` — always fail this and should be dropped rather
 * than hashed or persisted, so a phantom key doesn't make an otherwise-
 * identical spec object hash differently from one that never saw that key.
 * Exported for callers filtering one value at a time (e.g.
 * ProductSpecMergeService.buildCandidates, scanning per source per key)
 * rather than a whole object at once — see filterDefinedSpecs for that case.
 */
export function isSpecValueDefined(value: unknown): boolean {
  return isBoolean(value) || isNumber(value) || !isEmpty(value);
}

/**
 * Drops keys whose value fails `isSpecValueDefined` and sorts the rest —
 * the canonical, ready-to-hash-or-persist-or-send-to-the-LLM shape for a
 * deterministically-mapped spec object. Centralized here (rather than left
 * duplicated across ProductSourceRecordUpdaterService.processSpecs and
 * ProductSpecMergeService.isValueDefined, its two prior independent
 * implementations) specifically so hashSpecs can be called on the exact
 * object a caller is about to persist/send, instead of on a pre-filter
 * object a later filtering pass will still change — see hashSpecs.
 */
export function filterDefinedSpecs<T extends Record<string, unknown>>(
  specs: T | undefined,
): T {
  const filtered = Object.entries(specs ?? {})
    .filter(([, value]) => isSpecValueDefined(value))
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(filtered) as T;
}

/**
 * Deterministic SHA-256 hex digest of a canonical (already deterministically-
 * mapped) spec object — e.g. the offer-level or product-level split of
 * SpecExtractionService.extractSpecs' output (see
 * ProductDetailsPageScraperService). Sorts keys before hashing so the digest
 * is stable regardless of property-insertion order; values are hashed as-is
 * via JSON.stringify, so a change to any key's value (including array
 * element order, which can be meaningful) changes the digest.
 *
 * Deliberately hashes the post-deterministic-mapping object, not the raw
 * scraped label/value rows: two listings whose raw HTML differs in ways that
 * don't affect any mapped canonical field (e.g. whitespace/markup noise, or
 * a raw row the source's config doesn't map at all) should be treated as
 * unchanged for caching purposes, since neither the offer-identity nor the
 * model-spec post-process call's OUTPUT would differ from that noise. Hashing
 * the canonical object post-mapping is also strictly cheaper — no need to
 * reverse-map canonical spec keys back to source-specific raw label strings
 * to decide what counts as "offer-level" for hashing purposes; that split
 * already happened once, deterministically, via SpecExtractionService.
 *
 * Callers MUST pass the object already run through `filterDefinedSpecs` (or
 * an object already known to be in that shape) — this function does no
 * filtering of its own so that hashing, LLM-input-building, and persistence
 * can all deliberately share one already-filtered object rather than each
 * deriving their own slightly-different view of "the same" spec data.
 */
export function hashSpecs(specs: Record<string, unknown> | undefined): string {
  const sortedEntries = Object.entries(specs ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return createHash('sha256').update(JSON.stringify(sortedEntries)).digest('hex');
}
