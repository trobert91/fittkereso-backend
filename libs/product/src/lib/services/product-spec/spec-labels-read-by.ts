import { ProductSourceCategoryConfig } from '@fittkereso-backend/database';
import { normalizeSpecRowLabel } from './identity-spec-rows';

/**
 * How a source's spec row is read, judged by its label:
 * - `mapped`: a specMapping or calculated rule turns it into a spec;
 * - `identity`: only the identity extraction's `identitySpecRows` lists it;
 * - `unread`: no rule names it. Full spec unification (an LLM call) still
 *   sees it, but nothing deterministic does.
 */
export type SpecRowReader = 'mapped' | 'identity' | 'unread';

/** One specMapping label, with the key it fills and the mapping it belongs to. */
export interface SpecMappingLabel {
  key: string;
  label: string;
  sectionTitle?: string;
  /** The mapping's position in specMapping.mappings: its labels are alternatives. */
  mappingIndex: number;
}

export interface SpecLabelReaders {
  /** How a row with this label (and section title) is read. */
  readerOf(label: string, sectionTitle?: string): SpecRowReader;
  /** Every specMapping label of the section, with its key. */
  mappingLabels: SpecMappingLabel[];
}

/**
 * Which spec-row labels one category section of a source config reads.
 *
 * Matched the way the readers match: a specMapping label ignoring case only
 * (SpecExtractionService.findRawValue), within its `sectionTitle` when it
 * names one; an `identitySpecRows` label also ignoring stray whitespace
 * (selectIdentitySpecRows). A `calculated` rule reads labels too, except
 * `presentIfKey`, whose source is a spec key. Accents are never folded.
 */
export function specLabelsReadBy(
  section: ProductSourceCategoryConfig | undefined,
): SpecLabelReaders {
  const mappingLabels: SpecMappingLabel[] = [];
  const anySection = new Set<string>();
  const bySection = new Set<string>();
  const sectionKey = (label: string, sectionTitle: string) =>
    `${sectionTitle.toLowerCase()}\u0000${label.toLowerCase()}`;

  for (const [mappingIndex, mapping] of (section?.specMapping?.mappings ?? []).entries()) {
    for (const label of mapping.labels ?? []) {
      mappingLabels.push({ key: mapping.key, label, sectionTitle: mapping.sectionTitle, mappingIndex });
      if (mapping.sectionTitle) bySection.add(sectionKey(label, mapping.sectionTitle));
      else anySection.add(label.toLowerCase());
    }
  }
  for (const rule of section?.specMapping?.calculated ?? []) {
    if (rule.rule === 'presentIfKey') continue;
    const sources = Array.isArray(rule.source) ? rule.source : [rule.source];
    for (const label of sources) anySection.add(label.toLowerCase());
  }
  const identity = new Set((section?.identitySpecRows ?? []).map(normalizeSpecRowLabel));

  return {
    mappingLabels,
    readerOf(label: string, sectionTitle?: string): SpecRowReader {
      if (anySection.has(label.toLowerCase())) return 'mapped';
      if (sectionTitle && bySection.has(sectionKey(label, sectionTitle))) return 'mapped';
      if (identity.has(normalizeSpecRowLabel(label))) return 'identity';
      return 'unread';
    },
  };
}
