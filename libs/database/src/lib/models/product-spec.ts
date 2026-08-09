export type ProductSpecs = Record<
  string,
  string | number | boolean | string[] | undefined
>;

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
  options?: string[];
}

export interface SpecDefinitionProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  title: string;
  meta?: SpecDefinitionMeta;
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
