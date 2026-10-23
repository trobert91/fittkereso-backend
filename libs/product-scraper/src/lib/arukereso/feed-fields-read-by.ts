import { ArukeresoSourceConfig } from '@fittkereso-backend/database';
import { normalizeFieldName } from './arukereso-feed-item';

const ATTRIBUTE_PREFIX = 'attribute:';

export interface FeedFieldReaders {
  /**
   * The config parts that read this feed column (`mapping.price`, `filter`,
   * `extraSpecRows.ebikes:Kategória`), empty when none does. Matched as the
   * mapper matches a field name: normalized (normalizeFieldName).
   */
  readersOf(field: string): string[];
  /** Every column the config reads, normalized, with its readers. */
  fields: Map<string, string[]>;
  /** Attribute labels a filter condition tests (`attribute:<name>`), normalized. */
  filterAttributes: Set<string>;
}

/**
 * Which top-level columns of a feed row a feed source config reads.
 *
 * A column no part of the config names never reaches a listing: the mapper
 * keeps only the row's `attributes` as spec rows (toRawSpecs), so a `color`,
 * `ean` or `deliverytime` column is lost unless a `mapping` target, the
 * `filter` or a category section's `extraSpecRows` reads it. The category
 * rules read no column directly: they test the `categoryLabel` target, the
 * title and spec rows.
 */
export function feedFieldsReadBy(config: ArukeresoSourceConfig): FeedFieldReaders {
  const fields = new Map<string, string[]>();
  const filterAttributes = new Set<string>();
  const add = (field: string | undefined, reader: string) => {
    if (!field) return;
    const key = normalizeFieldName(field);
    const readers = fields.get(key) ?? [];
    if (!readers.includes(reader)) readers.push(reader);
    fields.set(key, readers);
  };

  for (const [target, entry] of Object.entries(config.mapping ?? {})) {
    for (const mapping of Array.isArray(entry) ? entry : [entry]) {
      add(mapping?.field, `mapping.${target}`);
    }
  }
  for (const condition of config.filter?.conditions ?? []) {
    if (condition.field.toLowerCase().startsWith(ATTRIBUTE_PREFIX)) {
      filterAttributes.add(normalizeFieldName(condition.field.slice(ATTRIBUTE_PREFIX.length)));
    } else {
      add(condition.field, 'filter');
    }
  }
  for (const [slug, section] of Object.entries(config.categories ?? {})) {
    for (const row of section.extraSpecRows ?? []) {
      add(row.field, `extraSpecRows.${slug}:${row.label}`);
    }
  }

  return {
    fields,
    filterAttributes,
    readersOf: (field: string) => fields.get(normalizeFieldName(field)) ?? [],
  };
}
