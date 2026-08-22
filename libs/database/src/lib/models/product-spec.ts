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
  /** Localized display label (e.g. Hungarian), shown to end users in place of `label` when present. */
  translation?: string;
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

export interface SpecDefinitionProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  title: string;
  /** Localized display title (e.g. Hungarian) shown to end users in place of `title`. */
  translation?: string;
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
