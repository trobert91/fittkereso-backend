// ─── JSON Schema for the scrape-operation vocabulary ──────────────────────
//
// The runtime counterpart to the `ScrapeOperation` union in
// scrape-operation.ts. That union is compile-time only: a config arrives as
// jsonb from an admin PUT, an MCP tool call or a seed file, and TypeScript
// has already left the building by then.
//
// Hand-written rather than generated from the types, for one reason: the
// `description` on every op and every parameter is the only documentation an
// author gets. Configs here are largely written by an LLM agent through the
// MCP `update_product_source` tool, and a generator would drop these — the
// comments in scrape-operation.ts are `//` line comments, not JSDoc.
//
// Kept in step with the union and the runtime registry by
// scrape-operation-schema.spec.ts, which compares this file's op enum against
// ScrapeOpRegistryService's registered handlers in both directions. Op names
// are the one thing here that realistically rots; a missing parameter shows
// up the moment a config using it is validated.

import { ScrapeOperation } from './scrape-operation';

/**
 * A JSON Schema fragment. Deliberately loose — this module's job is to be a
 * valid schema document, and ajv is the authority on whether it is one.
 */
export type JsonSchemaFragment = Record<string, unknown>;

/** Every op name, as the discriminator's enum. Derived from the union so a new
 *  member of `ScrapeOperation` that is not listed here is a compile error. */
export const SCRAPE_OPERATION_NAMES = [
  'appendSuffix',
  'appendSyntheticSpec',
  'assembleOffer',
  'assertContains',
  'branch',
  'buildBaseUrl',
  'coalesce',
  'computePages',
  'dedupe',
  'extractAttrList',
  'extractImageWithFallback',
  'extractLinkFromBox',
  'extractLinkTitlePairs',
  'extractSpecTableBySection',
  'extractSpecTableV1',
  'extractSpecTableV2',
  'extractTextList',
  'filterByAllowlist',
  'filterByAttrAbsent',
  'filterByAttrSuffix',
  'filterByBrandPrefix',
  'filterByCategoryYearSuffix',
  'filterByNonEmpty',
  'filterJsonArray',
  'filterOutEqualsIgnoreCase',
  'findScriptContaining',
  'flattenJsonArray',
  'forEachItem',
  'generatePaginationLinks',
  'identity',
  'isEmpty',
  'literal',
  'mapJsonArray',
  'mapSpecValue',
  'mapValue',
  'matchAgainstRuntimeList',
  'parseJsonAttr',
  'prependPrefix',
  'regexCapture',
  'selectAll',
  'selectAttr',
  'selectFirst',
  'selectNestedText',
  'selectSiblingContainer',
  'selectText',
  'splitAndSlice',
  'splitAndTake',
  'stripPattern',
  'stripPrefix',
  'takeFirst',
  'trim',
  'trimEnd',
  'wrapInArray',
] as const satisfies readonly ScrapeOperation['op'][];

/** A nested `ScrapeOperation[]`, by reference — see the pipeline def. */
const pipeline = (description: string): JsonSchemaFragment => ({
  $ref: '#/$defs/pipeline',
  description,
});

const str = (description: string): JsonSchemaFragment => ({
  type: 'string',
  description,
});

const bool = (description: string): JsonSchemaFragment => ({
  type: 'boolean',
  description,
});

const int = (description: string): JsonSchemaFragment => ({
  type: 'integer',
  description,
});

/** Present on every op via OpBase, so declared once on the operation def
 *  itself rather than repeated in all 51 branches. */
const OP_BASE_PROPERTIES: Record<string, JsonSchemaFragment> = {
  op: {
    enum: [...SCRAPE_OPERATION_NAMES],
    description: 'Which operation to run. See the matching branch for its parameters.',
  },
  as: str('Also store this step\'s result under this name in `vars`.'),
  on: str(
    'Read the input value from this `vars` entry instead of the pipeline\'s current value.',
  ),
};

/**
 * The per-op parameters, keyed by op name.
 *
 * Each entry becomes an `if`/`then` branch on the operation def. `required`
 * is listed separately from `properties` so an optional parameter is simply
 * absent from it.
 */
const OP_PARAMS: Record<
  (typeof SCRAPE_OPERATION_NAMES)[number],
  { description: string; properties?: Record<string, JsonSchemaFragment>; required?: string[] }
> = {
  // ─── Selection ─────────────────────────────────────────────────────────
  selectAll: {
    description: 'Select every element matching a CSS selector.',
    properties: {
      selector: str('CSS selector to query.'),
      within: str('A `vars` key holding a cheerio selection to scope the query to.'),
    },
    required: ['selector'],
  },
  selectFirst: {
    description: 'Select the first element matching a CSS selector.',
    properties: {
      selector: str('CSS selector to query.'),
      within: str('A `vars` key holding a cheerio selection to scope the query to.'),
      onMissing: {
        enum: ['throw', 'returnEmpty'],
        description: 'What to do when nothing matches. Defaults to returning empty.',
      },
    },
    required: ['selector'],
  },
  selectText: {
    description: 'Read element text.',
    properties: {
      selector: str(
        'CSS selector to query. Omit to read the text of the pipeline\'s current value itself — e.g. the current item inside a forEachItem sub-pipeline.',
      ),
      first: bool('Take only the first match.'),
      trim: bool('Trim surrounding whitespace.'),
    },
  },
  selectAttr: {
    description: 'Read an attribute off matching elements.',
    properties: {
      selector: str('CSS selector to query.'),
      attr: str('Attribute name to read, e.g. "href".'),
      first: bool('Take only the first match.'),
      trim: bool('Trim surrounding whitespace.'),
    },
    required: ['selector', 'attr'],
  },
  selectNestedText: {
    description: 'Read text from a child of the Nth matching element.',
    properties: {
      index: int('Zero-based index of the outer element.'),
      childSelector: str('Selector applied within that element.'),
      trim: bool('Trim surrounding whitespace.'),
      fallback: str('Value to use when nothing matches.'),
    },
    required: ['index', 'childSelector'],
  },
  selectSiblingContainer: {
    description:
      'Collect following siblings up to a boundary, then keep the ones matching a filter.',
    properties: {
      untilSelector: str('Stop collecting at the first sibling matching this.'),
      filterSelector: str('Keep only collected siblings matching this.'),
      first: bool('Take only the first match.'),
    },
    required: ['untilSelector', 'filterSelector'],
  },

  // ─── JSON-in-HTML extraction ───────────────────────────────────────────
  parseJsonAttr: {
    description:
      'Parse a JSON blob out of an attribute — a hydration payload such as Inertia\'s `data-page` or a Next.js/Nuxt-style script — for sources whose page state is embedded rather than rendered.',
    properties: {
      selector: str('Selector for the element carrying the blob, e.g. "#app".'),
      attr: str('Attribute holding the JSON, e.g. "data-page".'),
      path: str('Dot-path into the parsed JSON, e.g. "props.product.properties".'),
      first: bool('Take only the first match.'),
    },
    required: ['selector', 'attr'],
  },
  mapJsonArray: {
    description: 'Map each item of a JSON array into an object of resolved fields.',
    properties: {
      fields: {
        type: 'object',
        description: 'Output key -> how to resolve it from each array item.',
        additionalProperties: {
          type: 'object',
          properties: {
            path: str('Dot-path into each array item.'),
            template: str(
              'Template such as "{{value}} {{quantityUnit}}"; {{field}} resolves against the same item.',
            ),
            asArray: bool('Wrap the resolved value in a single-element array.'),
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      flattenField: str(
        'Use this single field\'s resolved value directly as each output element, producing a flat string[]/number[] instead of an object array. `fields` must still declare the key.',
      ),
    },
    required: ['fields'],
  },
  filterJsonArray: {
    description: 'Keep or drop JSON array items by comparing a field to a constant.',
    properties: {
      path: str('Dot-path into each item to test.'),
      equals: {
        type: ['string', 'number', 'boolean'],
        description: 'Keep items whose value strictly equals this.',
      },
      negate: bool('Invert the test — keep items that do NOT equal, e.g. to exclude used items.'),
    },
    required: ['path', 'equals'],
  },
  flattenJsonArray: {
    description:
      'Concatenate a nested array into one flat array — e.g. several image gallery groups, each with its own images[], collapsed into a single list.',
    properties: {
      path: str('Dot-path to the inner array within each outer item.'),
    },
    required: ['path'],
  },

  // ─── String manipulation ───────────────────────────────────────────────
  trim: { description: 'Trim surrounding whitespace.' },
  trimEnd: {
    description: 'Strip the given characters from the end of the value.',
    properties: { chars: str('Characters to strip.') },
    required: ['chars'],
  },
  appendSuffix: {
    description: 'Append a fixed string.',
    properties: { value: str('Text to append.') },
    required: ['value'],
  },
  prependPrefix: {
    description: 'Prepend a prefix, with {{var}} interpolation.',
    properties: {
      value: str('A `vars` key; defaults to the pipeline\'s current value.'),
      prefix: str('Prefix to prepend. Supports {{var}} interpolation.'),
    },
    required: ['prefix'],
  },
  stripPattern: {
    description: 'Remove every match of a regular expression.',
    properties: {
      value: str('A `vars` key; defaults to the pipeline\'s current value.'),
      pattern: str('Regex source. Supports {{var}} interpolation.'),
      flags: str('Regex flags, e.g. "gi".'),
      trim: bool('Trim the result.'),
    },
    required: ['pattern'],
  },
  stripPrefix: {
    description: 'Remove a leading prefix if present.',
    properties: {
      value: str('A `vars` key; defaults to the pipeline\'s current value.'),
      prefix: str('Prefix to remove. Supports {{var}} interpolation.'),
      flags: str('Regex flags, e.g. "i".'),
    },
    required: ['prefix'],
  },
  splitAndTake: {
    description: 'Split on a separator and take one part.',
    properties: {
      value: str('A `vars` key; defaults to the pipeline\'s current value.'),
      separator: str('Separator to split on.'),
      index: int('Zero-based index of the part to take.'),
      trim: bool('Trim the result.'),
    },
    required: ['separator', 'index'],
  },
  splitAndSlice: {
    description: 'Split on a separator and keep the remainder after skipping some parts.',
    properties: {
      value: str('A `vars` key; defaults to the pipeline\'s current value.'),
      separator: str('Separator to split on.'),
      skipFirst: int('How many leading parts to drop.'),
    },
    required: ['separator'],
  },
  coalesce: {
    description: 'Take the first non-empty value among several `vars` entries.',
    properties: {
      candidates: {
        type: 'array',
        items: { type: 'string' },
        description: '`vars` keys, in order. The first non-empty one wins.',
      },
    },
    required: ['candidates'],
  },
  identity: {
    description: 'Pass a value through unchanged — usually to copy it under a new name via `as`.',
    properties: { value: str('A `vars` key; defaults to the pipeline\'s current value.') },
  },
  wrapInArray: {
    description:
      'Always return a single-element array [value], whatever the value\'s own type. For sourcing forEachItem/offerList from something that must iterate exactly once even when the natural per-item array is empty. Wraps undefined as [undefined] rather than [].',
    properties: { value: str('A `vars` key; defaults to the pipeline\'s current value.') },
  },
  literal: {
    description: 'Emit a fixed constant, e.g. a hardcoded currency code.',
    properties: { value: str('The constant to emit.') },
    required: ['value'],
  },

  // ─── Regex ─────────────────────────────────────────────────────────────
  regexCapture: {
    description: 'Capture a group out of the value with a regular expression.',
    properties: {
      value: str('A `vars` key; defaults to the pipeline\'s current value.'),
      pattern: str('Regex source. Supports {{var}} interpolation.'),
      group: int('Capture group number to return.'),
      cast: {
        enum: ['number', 'string', 'jsonString'],
        description:
          'How to convert the captured text. Use "jsonString" to decode JSON string escapes (\\uXXXX, \\/, \\", \\\\) when capturing from inside a JSON or JS string literal, where the raw substring still carries its source escaping.',
      },
      trim: bool('Trim the captured value.'),
    },
    required: ['pattern', 'group'],
  },
  findScriptContaining: {
    description: 'Find the first <script> whose contents include the given text.',
    properties: { contains: str('Substring identifying the script.') },
    required: ['contains'],
  },

  // ─── Filtering / assertion ─────────────────────────────────────────────
  assertContains: {
    description: 'Assert the value contains a substring; otherwise halt or return empty.',
    properties: {
      value: str('A `vars` key; defaults to the pipeline\'s current value.'),
      substring: str('Substring that must be present.'),
      onFail: {
        enum: ['returnEmpty', 'throw'],
        description:
          'What to do when absent. "returnEmpty" short-circuits the ENTIRE pipeline, not just this step.',
      },
    },
    required: ['substring', 'onFail'],
  },
  filterByNonEmpty: {
    description: 'Require a non-empty value; otherwise halt or return empty.',
    properties: {
      value: str('A `vars` key; defaults to the pipeline\'s current value.'),
      onFail: {
        enum: ['returnEmpty', 'throw'],
        description:
          'What to do when empty. "returnEmpty" short-circuits the ENTIRE pipeline, not just this step.',
      },
    },
  },
  filterByAttrAbsent: {
    description: 'Keep only elements that do NOT carry the given attribute.',
    properties: { attr: str('Attribute whose absence is required.') },
    required: ['attr'],
  },
  filterByAttrSuffix: {
    description: 'Drop elements whose attribute value ends with the given suffix.',
    properties: {
      attr: str('Attribute to inspect.'),
      excludeSuffix: str('Suffix that causes an element to be dropped.'),
    },
    required: ['attr', 'excludeSuffix'],
  },
  filterByAllowlist: {
    description: 'Keep only entries whose title appears in a caller-supplied list.',
    properties: {
      against: str(
        'Runtime option supplied by the caller, e.g. "sourceTitles" for a category-title full sync.',
      ),
      caseInsensitive: bool('Compare case-insensitively.'),
      dedupeBy: str('Field to deduplicate the survivors by.'),
    },
    required: ['against'],
  },
  filterOutEqualsIgnoreCase: {
    description: 'Drop entries equal, ignoring case, to a value held in `vars`.',
    properties: { against: str('A `vars` key holding the value to exclude.') },
    required: ['against'],
  },
  filterByCategoryYearSuffix: {
    description: 'Keep only category links whose title ends in a recent model year.',
    properties: {
      yearsBack: int('How many years back from the current one to accept.'),
      includeCurrentYear: bool('Whether the current year itself is accepted.'),
    },
    required: ['yearsBack'],
  },
  dedupe: { description: 'Remove duplicate entries.' },
  takeFirst: {
    description: 'Keep only the first N entries.',
    properties: { count: int('How many to keep.') },
    required: ['count'],
  },
  isEmpty: {
    description: 'Resolve to whether the value is empty — for use in a branch condition.',
    properties: { value: str('A `vars` key; defaults to the pipeline\'s current value.') },
  },

  // ─── Link / pagination extraction ──────────────────────────────────────
  extractLinkTitlePairs: {
    description: 'Turn a selection of anchors into {url, title} pairs.',
    properties: {
      titleFromOwnTextExcludingChildren: bool(
        'Take the anchor\'s own text only, ignoring nested elements.',
      ),
      resolveRelativeAgainst: str('A `vars` key holding the base URL for relative hrefs.'),
    },
  },
  extractLinkFromBox: {
    description: 'Pull one link (and its title) out of each product/category box.',
    properties: {
      linkSelector: str('Selector for the anchor within each box.'),
      excludeHrefContains: str('Skip anchors whose href contains this.'),
      first: bool('Take only the first matching anchor per box.'),
      urlTransform: pipeline('Sub-pipeline applied to the extracted URL.'),
      titleFrom: {
        type: 'array',
        description:
          'Where to read the title from, in order of preference: "text", or "attr:<name>" such as "attr:title".',
        items: { type: 'string', pattern: '^(attr:.+|text)$' },
      },
      titleTransform: pipeline('Sub-pipeline applied to the extracted title.'),
      titleTemplate: str('Template for the final title, with {{var}} interpolation.'),
      categoryFrom: str('A `vars` key holding the category name to attach.'),
    },
    required: ['linkSelector'],
  },
  matchAgainstRuntimeList: {
    description: 'Keep entries whose field matches an entry in a runtime-provided list.',
    properties: {
      source: {
        enum: ['runtime:brandCache', 'runtime:brandNames', 'runtime:categoryBySlug'],
        description:
          'Which runtime data source to match against. A small, fixed set — not arbitrary database access.',
      },
      field: str('Field on each entry to compare.'),
      caseInsensitive: bool('Compare case-insensitively.'),
    },
    required: ['source', 'field'],
  },
  filterByBrandPrefix: {
    description: 'Keep entries whose field starts with a known brand name.',
    properties: {
      source: {
        enum: ['runtime:brandCache', 'runtime:brandNames', 'runtime:categoryBySlug'],
        description: 'Which runtime data source supplies the brand names.',
      },
      field: str('Field on each entry to compare.'),
      caseInsensitive: bool('Compare case-insensitively.'),
    },
    required: ['source', 'field'],
  },
  generatePaginationLinks: {
    description: 'Build one link per page from a total page count.',
    properties: {
      totalPages: str('A `vars` key holding the page count.'),
      startPage: int('First page number to generate.'),
      baseUrl: str('A `vars` key holding the base URL.'),
      urlTemplate: str('URL template, with {baseUrl} and {page} placeholders.'),
      titleTemplate: str('Title template, with the same placeholders.'),
    },
    required: ['totalPages', 'startPage', 'baseUrl', 'urlTemplate', 'titleTemplate'],
  },
  buildBaseUrl: {
    description: 'Derive a base URL from the task being scraped.',
    properties: {
      from: { const: 'task.url', description: 'The only supported source: the task\'s own URL.' },
      stripQuery: bool('Drop the query string.'),
      trimTrailingSlash: bool('Drop a trailing slash.'),
    },
    required: ['from'],
  },
  computePages: {
    description: 'Compute a page count from a total item count and a page size.',
    properties: {
      totalItems: str('A `vars` key holding the item count.'),
      perPage: int('Items per page.'),
    },
    required: ['totalItems', 'perPage'],
  },

  // ─── Spec-table extraction ─────────────────────────────────────────────
  extractSpecTableV1: {
    description: 'Extract a spec table whose section headers are marked inside the name cell.',
    properties: {
      rowSelector: str('Selector for each table row.'),
      sectionHeaderSelector: str(
        'Selector for a section-header marker relative to the name cell, e.g. "h3". When found inside the name cell, the row is a section divider rather than a spec row.',
      ),
      nameSelector: str('Selector for the spec name cell.'),
      nameExcludeChildren: bool('Read the name cell\'s own text only.'),
      valueCellIndex: int('Zero-based index of the value cell.'),
      listValueSelector: str('Selector for list items within the value cell.'),
      descriptionSelector: str('Selector for the description element.'),
      descriptionAttr: str('Attribute holding the description text.'),
      dedupeBy: { const: 'name', description: 'Deduplicate rows by spec name.' },
    },
    required: [
      'rowSelector',
      'sectionHeaderSelector',
      'nameSelector',
      'valueCellIndex',
      'listValueSelector',
      'descriptionSelector',
      'descriptionAttr',
      'dedupeBy',
    ],
  },
  extractSpecTableV2: {
    description: 'Extract a spec table whose section headers are marked by a row class.',
    properties: {
      rowSelector: str('Selector for each table row.'),
      sectionHeaderRowClass: str('Class marking a row as a section header.'),
      nameSelector: str('Selector for the spec name cell.'),
      descriptionSelector: str('Selector for the description element.'),
      descriptionAttr: str('Attribute holding the description text.'),
      valueContainerSelector: str('Selector for the element holding the value.'),
      valueIconFallback: {
        type: 'object',
        description: 'Where to read the value from when it is rendered as an icon.',
        properties: { selector: str('Icon selector.'), attr: str('Attribute holding the value.') },
        required: ['selector', 'attr'],
        additionalProperties: false,
      },
      dedupeBy: { const: 'name', description: 'Deduplicate rows by spec name.' },
    },
    required: [
      'rowSelector',
      'sectionHeaderRowClass',
      'nameSelector',
      'descriptionSelector',
      'descriptionAttr',
      'valueContainerSelector',
      'dedupeBy',
    ],
  },
  extractSpecTableBySection: {
    description: 'Extract specs from tables that follow their own section titles.',
    properties: {
      sectionTitleSelector: str('Selector for each section title.'),
      tableSelector: str('Selector for the table belonging to a section.'),
      tableRelation: {
        const: 'nextAll',
        description: 'How the table relates to its title. Only "nextAll" is supported.',
      },
      tableFirst: bool('Take only the first matching table per section.'),
      rowSelector: str('Selector for each row within the table.'),
      minCells: int('Rows with fewer cells than this are skipped.'),
      nameCellIndex: int('Zero-based index of the name cell.'),
      nameExcludeChildren: str('Selector for child elements to exclude from the name text.'),
      descriptionCellIndex: int('Zero-based index of the description cell.'),
      descriptionSelector: str('Selector for the description within that cell.'),
      valueCellIndex: int('Zero-based index of the value cell.'),
      splitValueOn: str('Separator used to split a multi-valued cell.'),
      htmlAware: bool('Treat the value cell as HTML rather than plain text.'),
    },
    required: [
      'sectionTitleSelector',
      'tableSelector',
      'tableRelation',
      'rowSelector',
      'minCells',
      'nameCellIndex',
      'descriptionCellIndex',
      'descriptionSelector',
      'valueCellIndex',
      'splitValueOn',
    ],
  },
  appendSyntheticSpec: {
    description:
      'Append a spec that is not in the table, computed by its own sub-pipeline — e.g. a value stated only in the title.',
    properties: {
      name: str('Spec name to append under.'),
      value: pipeline('Sub-pipeline producing the spec value.'),
    },
    required: ['name', 'value'],
  },

  // ─── Image / list extraction ───────────────────────────────────────────
  extractAttrList: {
    description: 'Collect one attribute from every element in a selection into a string[].',
    properties: {
      attr: str('Attribute to read from each element.'),
      trim: bool('Trim each value.'),
    },
    required: ['attr'],
  },
  extractTextList: {
    description:
      'Collect the text of every element in a selection into a string[]. The text-content counterpart to extractAttrList; blank entries are dropped rather than kept as "".',
    properties: { trim: bool('Trim each value.') },
  },
  extractImageWithFallback: {
    description: 'Read image URLs from a primary location, falling back to a second one.',
    properties: {
      primary: {
        type: 'object',
        description: 'Where to look first.',
        properties: {
          selector: str('Image selector.'),
          attr: str('Attribute holding the URL.'),
          mustContain: str('Only accept URLs containing this.'),
        },
        required: ['selector', 'attr'],
        additionalProperties: false,
      },
      fallback: {
        type: 'object',
        description: 'Where to look when the primary yields nothing.',
        properties: {
          selector: str('Image selector.'),
          attr: str('Attribute holding the URL.'),
          mustContain: str('Only accept URLs containing this.'),
          replacePatterns: {
            type: 'array',
            description: 'Substitutions applied to each fallback URL, e.g. thumbnail -> full size.',
            items: {
              type: 'object',
              properties: { from: str('Pattern to replace.'), to: str('Replacement.') },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
        },
        required: ['selector', 'attr'],
        additionalProperties: false,
      },
    },
    required: ['primary', 'fallback'],
  },

  // ─── Value mapping ─────────────────────────────────────────────────────
  mapSpecValue: {
    description:
      'Look a value up in the already-extracted rawSpecs by label, via ProductValueMapperService.',
    properties: {
      label: str('Spec label to read from rawSpecs.'),
      single: bool('Return a single value rather than a list.'),
      cast: { const: 'number', description: 'Convert the result to a number.' },
    },
    required: ['label', 'single'],
  },
  mapValue: {
    description:
      'Map the pipeline\'s current value through a lookup table — e.g. a raw stock status to a canonical one. Unlike mapSpecValue, this reads the pipeline value rather than rawSpecs.',
    properties: {
      value: str('A `vars` key; defaults to the pipeline\'s current value.'),
      cases: {
        type: 'object',
        description: 'Input value -> output value.',
        additionalProperties: { type: 'string' },
      },
      default: str('Value to use when nothing matches.'),
    },
    required: ['cases'],
  },

  // ─── Control flow ──────────────────────────────────────────────────────
  branch: {
    description: 'Run one of two sub-pipelines depending on a condition.',
    properties: {
      condition: {
        type: 'object',
        description: 'Exactly one of these decides the branch.',
        properties: {
          selectorExists: str('True when this CSS selector matches something.'),
          isEmpty: str('A `vars` key; true when its value is empty.'),
          equals: {
            type: 'object',
            description: 'True when a `vars` value equals a fixed constant.',
            properties: {
              value: str('A `vars` key.'),
              to: {
                type: ['string', 'number', 'boolean'],
                description: 'The constant to compare against.',
              },
            },
            required: ['value', 'to'],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
        minProperties: 1,
      },
      ifTrue: pipeline('Sub-pipeline run when the condition holds.'),
      ifFalse: pipeline('Sub-pipeline run when it does not.'),
    },
    required: ['condition', 'ifTrue', 'ifFalse'],
  },

  // ─── Iteration ─────────────────────────────────────────────────────────
  forEachItem: {
    description:
      'Run a sub-pipeline once per entry of the input collection, against a per-item-scoped `vars` clone so an `as` from one item never leaks into the next.',
    properties: {
      itemMode: {
        enum: ['cheerio', 'json'],
        description:
          '"cheerio": the input is a selection and each item is exposed as a single-element selection. "json": the input is an array and each item is exposed directly.',
      },
      itemVar: str('Name the current item is exposed under. Defaults to "item".'),
      indexVar: str('Name the current index is exposed under. Defaults to "itemIndex".'),
      itemPipeline: pipeline('Sub-pipeline run once per item.'),
      skipEmptyResults: bool('Drop items whose pipeline yields nothing. Defaults to true.'),
    },
    required: ['itemMode', 'itemPipeline'],
  },
  assembleOffer: {
    description:
      'Assemble one offer from several independent sub-pipelines run against the item-scoped context. Yields nothing when `price` does not resolve. Seller is never scraped — every offer belongs to its ProductSource\'s own seller.',
    properties: {
      price: pipeline('Sub-pipeline producing the price. Required for the offer to be kept.'),
      priceWithoutDiscount: pipeline('Sub-pipeline producing the pre-discount price.'),
      currency: pipeline('Sub-pipeline producing the currency code.'),
      availability: pipeline('Sub-pipeline producing the availability.'),
      url: pipeline('Sub-pipeline producing the offer URL.'),
      externalId: pipeline('Sub-pipeline producing the source-native offer id.'),
      locations: pipeline(
        'Sub-pipeline producing store/warehouse names where this offer is physically available. Most sources have no per-location breakdown — resolve to undefined, not [].',
      ),
      specs: {
        type: 'object',
        description: 'Offer-level spec key -> sub-pipeline producing its value.',
        additionalProperties: { $ref: '#/$defs/pipeline' },
      },
    },
    required: ['price'],
  },
};

/** One `if`/`then` branch per op, discriminated on `op`. */
const operationBranches: JsonSchemaFragment[] = SCRAPE_OPERATION_NAMES.map((name) => {
  const spec = OP_PARAMS[name];
  return {
    if: { properties: { op: { const: name } }, required: ['op'] },
    then: {
      ...(spec.properties ? { properties: spec.properties } : {}),
      ...(spec.required ? { required: spec.required } : {}),
    },
  };
});

/**
 * One operation.
 *
 * `allOf` of `if`/`then` on `op` rather than a 51-branch `oneOf`: a `oneOf`
 * failure makes ajv report every branch that did not match, which for 51 ops
 * is a wall of text that says nothing about the actual mistake. Discriminated
 * this way, a bad `selectAll` reports only what `selectAll` requires.
 *
 * `unevaluatedProperties` rather than `additionalProperties`, and this is the
 * subtle half: `additionalProperties` does not see through `allOf`, so it
 * would reject every op parameter as unknown. `unevaluatedProperties` does,
 * which is what turns a typo'd parameter name into an error instead of a
 * silently ignored key. It needs draft 2020-12 — hence ajv/dist/2020 in the
 * validator.
 */
export const SCRAPE_OPERATION_SCHEMA: JsonSchemaFragment = {
  type: 'object',
  description: 'One step of a scrape pipeline.',
  properties: OP_BASE_PROPERTIES,
  required: ['op'],
  allOf: operationBranches,
  unevaluatedProperties: false,
};

/** An ordered list of operations, executed left to right. */
export const SCRAPE_PIPELINE_SCHEMA: JsonSchemaFragment = {
  type: 'array',
  description:
    'An ordered list of operations, executed left to right against a shared context. Each step receives the previous step\'s value unless it reads from `vars` via `on`.',
  items: { $ref: '#/$defs/operation' },
};
