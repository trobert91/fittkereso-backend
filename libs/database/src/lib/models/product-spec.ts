export type ProductSpecs = Record<
  string,
  string | number | boolean | string[] | undefined
>;

/**
 * Raw label/value pair as extracted from a source's spec table, before
 * SpecExtractionService/ProductSourcePostProcessService map it into
 * canonical ProductSpecs keys. Lives in @fittkereso-backend/database (not
 * @fittkereso-backend/product, which re-exports it) because
 * ProductSourceRecord.rawSpecs needs the type and database cannot depend on
 * product (product already depends on database).
 */
export interface ScrapedProductSpec {
  name: string;
  sectionTitle?: string;
  description?: string;
  values?: string[];
}

export interface OrderedSpec {
  key: string;
  label: string;
  value: string | number | boolean | string[] | undefined;
}

export type UnitFormat = 'space' | 'none';

export interface SpecDefinitionMeta {
  unit?: string;
  unitFormat?: UnitFormat;
  order?: number;
  examples?: string[];
  /**
   * Plausible-range bounds for a numeric field. Consulted only by
   * ProductSpecMergeService's Tier-1 disqualification step, to drop a
   * candidate value that's outside a sane range before scoring (e.g. a frame
   * size mistakenly reported in inches instead of cm lands here as `17`
   * against a `[30, 70]` cm bound). Deliberately advisory, not enforced by
   * ProductSpecValidatorService's schema validation — kept loose enough that
   * a genuine outlier (e.g. an unusually heavy cargo bike) doesn't get
   * silently dropped, only implausible unit/transcription errors.
   */
  min?: number;
  max?: number;
}

/**
 * One rule in a category's derived-spec table — ProductSpecMergeService's
 * Tier 0, which runs after normal per-key resolution (Tiers 1-4) and
 * overrides specific keys wholesale when a component identifier resolves
 * unambiguously to a known part. A manufacturer's own datasheet for e.g. a
 * motor model code is a more reliable source of that motor's torque/power
 * than any individual shop's own (frequently mistranscribed) listing — see
 * docs/SpecUnificationAnalysis.md and docs/EbikeSpecExtensionAnalysis.md §4.2
 * for the discrepancies this is meant to correct.
 */
export interface DerivedSpecRule {
  /** Case-insensitive substrings matched against the resolved sourceKey value. First match wins. */
  match: string[];
  /** Human-readable label for the matched component, log-only. */
  label?: string;
  /** Canonical spec key/value pairs forced onto the merge result when this rule matches. */
  specs: ProductSpecs;
}

/**
 * A derivation source for one category: `sourceKey` names an already-resolved
 * canonical spec (e.g. "motorModel"); each rule's `match` substrings are
 * tested against that resolved value to force in the mapped `specs`.
 */
export interface DerivedSpecConfig {
  sourceKey: string;
  rules: DerivedSpecRule[];
}

export interface SpecDefinitionProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  title: string;
  meta?: SpecDefinitionMeta;
  /** Closed set of allowed values for a categorical string field — a
   *  standard JSON Schema enum, enforced by ProductSpecValidatorService
   *  (flags specValid: false on mismatch, doesn't reject) and used by
   *  ProductSourcePostProcessService to constrain LLM extraction. Only use
   *  for genuinely fixed vocabularies (materials, mechanism types, size
   *  labels); free-text/marketing categories should stay as
   *  `meta.examples` instead — see docs discussion. */
  enum?: string[];
}

export interface SpecDefinitionJsonSchema {
  title: string;
  type: 'object';
  properties: Record<string, SpecDefinitionProperty>;
  additionalProperties?: boolean;
  required?: string[];
}

export type SpecDefinitionUiSchema = {
  [key: string]: UiSchemaField;
};

export interface UiSchemaField {
  /** Autofocus the input */
  'ui:autofocus'?: boolean;

  /** Placeholder text */
  'ui:placeholder'?: string;

  /** If set, replaces undefined with this value */
  'ui:emptyValue'?: any;

  /** HTML description (markdown if enabled) */
  'ui:description'?: string;

  /** Enable markdown rendering inside the description */
  'ui:enableMarkdownInDescription'?: boolean;

  /** Override field title */
  'ui:title'?: string;

  /** Help text */
  'ui:help'?: string;

  /** Autocomplete attribute */
  'ui:autocomplete'?: string;

  /** Widget type: string names or a component */
  'ui:widget'?: string;

  /** Additional options for the widget */
  'ui:options'?: {
    [key: string]: any;
  };

  /** Anything else RJSF supports */
  [key: string]: any;
}
