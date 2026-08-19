import { createHash } from 'crypto';
import { sortBy } from 'lodash';

interface HashableSpec {
  name: string;
  sectionTitle?: string;
  description?: string;
  values?: string[];
}

/**
 * Deterministic SHA-256 hex digest of a source's raw scraped specs, used to
 * detect whether a page's spec table changed since the last scrape (see
 * ProductSourceRecord.rawSpecsHash). Sorts entries by name/sectionTitle before
 * hashing so the digest is stable regardless of row-extraction order — but
 * preserves each entry's own `values` order, since that can be meaningful
 * (e.g. an ordered list spec) and a change in it is a real content change.
 */
export function hashRawSpecs(specs: HashableSpec[] | undefined): string {
  const normalized = sortBy(specs ?? [], ['sectionTitle', 'name']).map(
    (spec) => ({
      name: spec.name,
      sectionTitle: spec.sectionTitle,
      description: spec.description,
      values: spec.values,
    }),
  );
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
