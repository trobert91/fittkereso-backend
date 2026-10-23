import { ProductSourceCategoryConfig } from '@fittkereso-backend/database';
import { normalizeSpecRowLabel } from './identity-spec-rows';

/**
 * How a source's spec row is read, judged by its label:
 * - `mapped`: a specMapping or calculated rule turns it into a spec;
 * - `pipeline`: a product-page pipeline reads it (a `mapSpecValue` step, e.g.
 *   the release year from a "Modellév" row);
 * - `identity`: only the identity extraction's `identitySpecRows` lists it;
 * - `unread`: no rule names it. Full spec unification (an LLM call) still
 *   sees it, but nothing deterministic does.
 */
export type SpecRowReader = 'mapped' | 'pipeline' | 'identity' | 'unread';

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
 *
 * Pass the source's whole config to also count the rows its product-page
 * pipelines read (`detailPage`, scraping and feed alike). A feed's `mapping`
 * is left out: it reads columns, and a `mapSpecValue` there sees no rows.
 */
export function specLabelsReadBy(
  section: ProductSourceCategoryConfig | undefined,
  config?: unknown,
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
  const pipeline = new Set<string>();
  collectMapSpecValueLabels((config as { detailPage?: unknown } | undefined)?.detailPage, pipeline);

  return {
    mappingLabels,
    readerOf(label: string, sectionTitle?: string): SpecRowReader {
      if (anySection.has(label.toLowerCase())) return 'mapped';
      if (sectionTitle && bySection.has(sectionKey(label, sectionTitle))) return 'mapped';
      if (pipeline.has(label.toLowerCase())) return 'pipeline';
      if (identity.has(normalizeSpecRowLabel(label))) return 'identity';
      return 'unread';
    },
  };
}

/** Every `mapSpecValue` label in a pipeline tree, lower-cased (the op matches ignoring case). */
function collectMapSpecValueLabels(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectMapSpecValueLabels(item, into);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const op = node as { op?: unknown; label?: unknown };
  if (op.op === 'mapSpecValue' && typeof op.label === 'string') into.add(op.label.toLowerCase());
  for (const value of Object.values(node)) collectMapSpecValueLabels(value, into);
}
