import { createHash } from 'crypto';

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
 */
export function hashSpecs(specs: Record<string, unknown> | undefined): string {
  const sortedEntries = Object.entries(specs ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return createHash('sha256').update(JSON.stringify(sortedEntries)).digest('hex');
}
