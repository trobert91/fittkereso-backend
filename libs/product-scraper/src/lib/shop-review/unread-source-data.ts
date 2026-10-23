import { RawSpecLabelRow } from '@fittkereso-backend/database';
import { SpecLabelReaders, SpecMappingLabel, SpecRowReader } from '@fittkereso-backend/product';
import { ArukeresoFeedItem } from '../arukereso/arukereso-feed-item';
import { FeedFieldReaders } from '../arukereso/feed-fields-read-by';

/** A spec-row label of a source, with how its category section reads it. */
export interface ReviewedSpecLabel extends RawSpecLabelRow {
  reader: SpecRowReader;
}

/** A specMapping entry none of whose labels a stored row carries: stale, or spelt unlike the shop's rows. */
export interface StaleMapping {
  slug: string;
  key: string;
  labels: string[];
  sectionTitle?: string;
}

/** One top-level feed column across stored feed rows. */
export interface FeedFieldStat {
  /** The column, as the feed item keys it (normalized). */
  name: string;
  /** Rows with a non-empty value. */
  filled: number;
  /** Up to three distinct values, cut to 120 characters. */
  examples: string[];
  /** The config parts that read it; empty when none does. */
  readers: string[];
}

/** Each counted label with how its category section reads it. */
export function reviewSpecLabels(
  rows: RawSpecLabelRow[],
  readersOf: (slug: string | null) => SpecLabelReaders,
): ReviewedSpecLabel[] {
  return rows.map((row) => ({
    ...row,
    reader: readersOf(row.slug).readerOf(row.name, row.sectionTitle ?? undefined),
  }));
}

/**
 * The specMapping entries of one category section none of whose labels a
 * stored row of the source carries, matched as findRawValue matches
 * (ignoring case, within the entry's section title when it names one). An
 * entry with one matching label is fine: its other labels are alternative
 * spellings. With few listings this can be chance: a row the stored products
 * just don't have.
 */
export function staleMappings(
  slug: string,
  readers: SpecLabelReaders,
  rows: RawSpecLabelRow[],
): StaleMapping[] {
  const carried = rows.filter((row) => row.slug === slug);
  const isCarried = (mapping: SpecMappingLabel) =>
    carried.some(
      (row) =>
        row.name.toLowerCase() === mapping.label.toLowerCase() &&
        (!mapping.sectionTitle ||
          (row.sectionTitle ?? '').toLowerCase() === mapping.sectionTitle.toLowerCase()),
    );
  const entries = new Map<number, SpecMappingLabel[]>();
  for (const label of readers.mappingLabels) {
    entries.set(label.mappingIndex, [...(entries.get(label.mappingIndex) ?? []), label]);
  }
  return [...entries.values()]
    .filter((labels) => !labels.some(isCarried))
    .map((labels) => ({
      slug,
      key: labels[0].key,
      labels: labels.map((label) => label.label),
      sectionTitle: labels[0].sectionTitle,
    }));
}

/**
 * Fill rate, examples and readers of every top-level column of these feed
 * rows. The columns no reader names are what the config drops: a row's
 * `attributes` become spec rows, its columns only what a target reads.
 */
export function feedFieldStats(
  items: Pick<ArukeresoFeedItem, 'fields'>[],
  readers: FeedFieldReaders,
): FeedFieldStat[] {
  const stats = new Map<string, { filled: number; examples: Set<string> }>();
  for (const item of items) {
    for (const [name, value] of Object.entries(item.fields ?? {})) {
      const stat = stats.get(name) ?? { filled: 0, examples: new Set<string>() };
      const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
      if (text) {
        stat.filled += 1;
        if (stat.examples.size < 3) stat.examples.add(text.slice(0, 120));
      }
      stats.set(name, stat);
    }
  }
  return [...stats.entries()]
    .map(([name, stat]) => ({
      name,
      filled: stat.filled,
      examples: [...stat.examples],
      readers: readers.readersOf(name),
    }))
    .sort((a, b) => b.filled - a.filled || a.name.localeCompare(b.name));
}

/**
 * Columns filled in one set of feed rows and empty or absent in the other:
 * a shop that changed its export. Compared by whether any row fills them.
 */
export function feedFieldChanges(
  before: FeedFieldStat[],
  now: FeedFieldStat[],
): { appeared: string[]; vanished: string[] } {
  const filled = (stats: FeedFieldStat[]) =>
    new Set(stats.filter((stat) => stat.filled > 0).map((stat) => stat.name));
  const was = filled(before);
  const is = filled(now);
  return {
    appeared: [...is].filter((name) => !was.has(name)).sort(),
    vanished: [...was].filter((name) => !is.has(name)).sort(),
  };
}
