// ─── JSON Schema for ProductSource.config ─────────────────────────────────
//
// The runtime counterpart to the `ProductSourceConfig` interface in
// product-source-config.ts, which is compile-time only — a config reaches us
// as jsonb from an admin PUT, an MCP tool call or a seed file, long after
// TypeScript has stopped being able to say anything about it.
//
// A .ts constant rather than a .json file on disk, deliberately. The apps'
// webpack builds ship `assets: ['./src/config']` and nothing else, and the
// existing disk-loading pattern (CategoryConfigService) resolves paths
// against process.cwd(), which finds nothing once an app runs from dist and
// fails silently. A constant is bundled with the code that uses it. Same
// arrangement as dynamicConfigSchema in libs/dynamic-config.
//
// Lives in libs/database beside the types it describes, which is also the
// only place every consumer can reach: the save path (libs/product), the run
// path (apps/product-collector), apps/api and apps/mcp. Note libs/database
// must not import libs/logger — that closes a cycle through libs/config — but
// a schema needs no logger.

import {
  JsonSchemaFragment,
  SCRAPE_OPERATION_SCHEMA,
  SCRAPE_PIPELINE_SCHEMA,
} from './scrape-operation.schema';
import { ARUKERESO_MAPPING_TARGETS } from './product-source-config';

const pipelineRef = (description: string): JsonSchemaFragment => ({
  $ref: '#/$defs/pipeline',
  description,
});

/** How a raw source value is converted before it becomes a canonical spec. */
const SPEC_EXTRACT_MODES = [
  'raw',
  'number',
  'secondNumber',
  'roundedNumber',
  'ceiledNumber',
  'removeWhitespace',
  'list',
  'regexpList',
  'cmToInchList',
  'mmToCmAndInchList',
  'standardRatio',
  'shuffledList',
] as const;

/**
 * One condition in a category lookup rule.
 *
 * `minProperties: 1` rather than a `oneOf` over the four shapes: the union is
 * genuinely exclusive in TypeScript, but a `oneOf` here would report all four
 * alternatives on any mistake, and the interpreter reads whichever key is
 * present. Requiring at least one keeps the useful error — "you wrote a rule
 * with no condition" — without the wall.
 */
const categoryLookupCondition: JsonSchemaFragment = {
  type: 'object',
  description: 'Matches a product against a category. Give exactly one of these keys.',
  properties: {
    equalsIgnoreCase: {
      type: 'string',
      description: 'Matches when the resolved breadcrumb/source text equals this, ignoring case.',
    },
    specValueIncludes: {
      type: 'object',
      description: 'Matches when a raw spec\'s value contains one of the given strings.',
      properties: {
        label: { type: 'string', description: 'Raw spec label to inspect.' },
        anyOf: {
          type: 'array',
          items: { type: 'string' },
          description: 'Any one of these matching is enough.',
        },
      },
      required: ['label', 'anyOf'],
      additionalProperties: false,
    },
    specSectionTitleIn: {
      type: 'array',
      items: { type: 'string' },
      description: 'Matches when the spec table has a section with one of these titles.',
    },
    always: {
      const: true,
      description: 'Always matches — the catch-all for a single-category source.',
    },
  },
  additionalProperties: false,
  minProperties: 1,
};

/**
 * A run-size cap and a catalogue filter, shared by both config shapes.
 *
 * Both exist for the same job — assembling a small, representative test set
 * without hand-picking URLs or editing a source's real config — so they are
 * defined once and spliced into each shape rather than written twice.
 */
const maxItemsSchema: JsonSchemaFragment = {
  type: 'integer',
  minimum: 1,
  description:
    'Hard ceiling on how many items ONE RUN imports, counted in items imported rather than items seen. Omit for no ceiling, which is what a production source wants. A feed run honours this exactly; on a scraping source it caps items PER LIST PAGE (each page is its own task, so they share no counter) and additionally restricts the run to the first page of each listing.',
};

const filterConditionSchema: JsonSchemaFragment = {
  type: 'object',
  description:
    'One test against one field. Give `field` plus exactly one operator.',
  properties: {
    field: {
      type: 'string',
      description:
        'Which field to test. For an arukereso source: ANY feed column, matched case-insensitively with _, - and spaces stripped, plus `attribute:<name>` for one of the feed\'s attribute pairs. For a scraping source: any list-card field (name, url, price, externalId, availability).',
    },
    equals: { type: 'string', description: 'Exact match.' },
    notEquals: { type: 'string', description: 'Anything but this.' },
    contains: { type: 'string', description: 'Substring match.' },
    notContains: { type: 'string', description: 'Substring must be absent.' },
    matches: {
      type: 'string',
      description: 'Regular expression, tested against the whole value.',
    },
    in: {
      type: 'array',
      items: { type: 'string' },
      description: 'Value must be one of these.',
    },
    notIn: {
      type: 'array',
      items: { type: 'string' },
      description: 'Value must be none of these.',
    },
    gt: { type: 'number', description: 'Numeric greater-than.' },
    gte: { type: 'number', description: 'Numeric greater-or-equal.' },
    lt: { type: 'number', description: 'Numeric less-than.' },
    lte: { type: 'number', description: 'Numeric less-or-equal.' },
    isEmpty: {
      type: 'boolean',
      description:
        'true matches only an absent or empty field; false only a present one.',
    },
  },
  required: ['field'],
  additionalProperties: false,
  // `field` plus at least one operator — a condition with no operator would
  // match everything while looking like it filters.
  minProperties: 2,
};

const filterSchema: JsonSchemaFragment = {
  type: 'object',
  description:
    'Narrows a run to a subset of the source\'s catalogue — "just the KTMs", "only bikes over 500k" — for building a small test set without editing the rest of the config. Omit to import everything. Filters what is IMPORTED, not what is fetched: the feed still downloads whole and a list page is still parsed whole.',
  properties: {
    match: {
      enum: ['all', 'any'],
      description:
        'Whether every condition must hold, or just one. Default: all.',
    },
    caseSensitive: {
      type: 'boolean',
      description:
        'Default false — string comparisons ignore case, which is almost always what is meant.',
    },
    conditions: {
      type: 'array',
      minItems: 1,
      items: filterConditionSchema,
      description: 'Tried in order; `match` decides how they combine.',
    },
  },
  required: ['conditions'],
  additionalProperties: false,
};

const identityExtractionSchema: JsonSchemaFragment = {
  type: 'object',
  description:
    "What the LLM identity extraction reads from this source's listings. Per source because it is about the shop's labels; the fields the extraction outputs are category config.",
  properties: {
    specRows: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description:
        'Allowlist of spec-table row labels sent to the identity extraction: the rows carrying frame, motor, battery, wheel, drivetrain, weight or year. Matched ignoring case (as specMapping labels are) and stray whitespace, but not accents. Omit to send the whole table, which suits a shop whose table is already short. Full spec unification always gets the whole table.',
    },
  },
  additionalProperties: false,
};

/**
 * The LLM post-processing block, shared by both config shapes.
 *
 * Shared rather than duplicated because it IS the same block, read by the same
 * service: a feed's `name` field is the shop's full marketing title just as a
 * detail page's title is, and both need the same cleanup before identity
 * resolution sees them.
 */
const postProcessConfigSchema: JsonSchemaFragment = {
  type: 'object',
  description:
    'Per-source switch for the LLM post-processing pass that runs after deterministic extraction. On by default — a source with no block at all still runs it.',
  properties: {
    enabled: {
      type: 'boolean',
      description: 'Set false to opt this source out, e.g. where inference adds nothing.',
    },
    model: { type: 'string', description: 'Model identifier to use.' },
    thinking: {
      type: 'boolean',
      description:
        'Reasoning toggle. Leave unset for the service default. False suits sources whose spec table is already near-canonical (re-keying, not inference); sources publishing only a free-text component list do need it.',
    },
    effort: {
      type: 'string',
      description:
        'Provider-native reasoning effort, forwarded as-is. Supplying this implies thinking is enabled.',
    },
    maxTokens: {
      type: 'integer',
      minimum: 1,
      description:
        'Ceiling on generated tokens. Must stay well above a fully-populated specs object — a truncated response fails JSON parsing and silently degrades the pass to deterministic-only.',
    },
    includeDescriptionInOfferIdentity: {
      type: 'boolean',
      description:
        'Whether the extracted description reaches the identity extraction (the per-listing call reading the name, size, colour, year and other identity fields). Defaults to false — a marketing blurb rarely states those better than the title and spec table.',
    },
    includeDescriptionInModelSpecs: {
      type: 'boolean',
      description:
        'Whether the extracted description reaches full spec unification (the once-per-product call filling every non-identity field). Defaults to true. Set false for a source whose description is pure sales copy.',
    },
  },
  additionalProperties: false,
};

export const SCRAPING_SOURCE_CONFIG_SCHEMA: JsonSchemaFragment = {
  // NO `$schema` DECLARATION, deliberately — do not add one back.
  //
  // This document is written for draft 2020-12 and the backend validates it
  // with an Ajv2020 instance, which applies that dialect whether or not the
  // document says so. But the same document is served to the admin config
  // editor, whose validator (@rjsf/validator-ajv8) runs a draft-07 Ajv. A
  // draft-07 Ajv handed a document declaring the 2020-12 meta-schema fails to
  // process it at all — "no schema with key or ref .../2020-12/schema" — and
  // the editor then rejects perfectly valid configs, which blocks saving them.
  //
  // Without the declaration each side applies its own dialect to one shared
  // document: the backend keeps full 2020-12 semantics, and the editor gets
  // draft-07, under which `unevaluatedProperties` is simply ignored. The only
  // thing that costs is the typo'd-parameter check client-side; unknown ops,
  // missing parameters, bad enum values and unknown keys are all still caught
  // while typing, and the backend remains the authority on every save.
  $id: 'https://fittkereso.hu/schemas/scraping-source-config.json',
  title: 'Scraping product source config',
  description:
    'The complete declarative definition of a type:"scraping" source: where to start, how to parse list and detail pages, and how to map raw specs onto the category schema.',
  type: 'object',
  required: ['baseUrl', 'startUrls', 'listPage', 'detailPage'],
  additionalProperties: false,

  properties: {
    baseUrl: {
      type: 'string',
      description:
        'The site\'s canonical base URL (scheme + host), e.g. https://www.example.com. Also exposed to pipelines as {{baseUrl}}.',
    },
    startUrls: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description:
        'Where each import run begins — a category listing, or a hub page when categoryLinks is set. Replaces the old fullSyncStartUrl + discovery pair: discovery existed to FIND these by matching category titles or brand names, and naming them outright is both simpler and the only thing any live source ever needed.',
    },

    categoryLinks: pipelineRef(
      'Optional. Expands a start URL into category listing URLs, for a hub page rather than a listing. Walked ONCE per run by the importer — a list page has no power to enqueue more list pages, which is what makes a self-paginating listing unable to re-emit its own page range.',
    ),
    maxItems: maxItemsSchema,
    filter: filterSchema,
    identityExtraction: identityExtractionSchema,

    categories: {
      type: 'object',
      description:
        'Which product categories this source is onboarded for, keyed by category slug.',
      additionalProperties: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description:
              'Whether products resolving to this category are scraped. A disabled category is skipped at detail-page time.',
          },
          sourceTitle: {
            type: 'string',
            description:
              'What this site calls the category, used by discovery mode "categoryTitleMatch".',
          },
        },
        required: ['enabled'],
        additionalProperties: false,
      },
    },

    listPage: {
      type: 'object',
      description: 'How one category/list page is parsed into product cards.',
      properties: {
        categoryName: pipelineRef('Pipeline producing this page\'s category name.'),
        pagination: {
          type: 'object',
          description:
            'How to enumerate the remaining pages of this listing. Omit when the listing fits on one page. Evaluated ONCE per run against page 1, by the importer.',
          properties: {
            urlTemplate: {
              type: 'string',
              description:
                'Template for page N, supporting {{startUrl}}, {{baseUrl}} and {{page}}. e.g. "{{startUrl}}?page={{page}}"',
            },
            pageCount: pipelineRef(
              'Pipeline run against page 1 yielding the total page count. A pipeline rather than a fixed number so the walk tracks catalog growth instead of silently truncating as the shop adds products.',
            ),
          },
          required: ['urlTemplate', 'pageCount'],
          additionalProperties: false,
        },
        items: pipelineRef(
          'Pipeline producing the array of product cards on this page — a cheerio selection or a JSON array.',
        ),
        itemMode: {
          enum: ['cheerio', 'json'],
          description:
            '"cheerio": each card is a single-element selection under vars.item. "json": each card is the raw object. See forEachItem.',
        },
        itemPipeline: {
          allOf: [
            { $ref: '#/$defs/pipeline' },
            {
              contains: {
                properties: { op: { const: 'assembleListProduct' } },
                required: ['op'],
              },
            },
          ],
          description:
            'Run once per card; must terminate in an assembleListProduct op.',
        },
      },
      required: ['categoryName', 'items', 'itemMode', 'itemPipeline'],
      additionalProperties: false,
    },
    detailPage: {
      type: 'object',
      description: 'How a product detail page is parsed.',
      properties: {
        rawSpecs: pipelineRef(
          'Pipeline producing the raw label/value spec pairs. Runs first, because category resolution can inspect them.',
        ),
        description: pipelineRef(
          'Pipeline producing free-text marketing copy. Optional and lower-confidence than rawSpecs by nature, but some sources state values only here.',
        ),
        category: {
          type: 'object',
          description: 'How this page\'s product is resolved to a category slug.',
          properties: {
            breadcrumbOrSource: pipelineRef(
              'Pipeline producing the text the lookup rules are matched against.',
            ),
            slugLookup: {
              type: 'array',
              description:
                'Rules tried in order; the first whose `when` matches and whose `unless` does not wins.',
              items: {
                type: 'object',
                properties: {
                  when: { ...categoryLookupCondition, description: 'Condition that selects this rule.' },
                  slug: {
                    type: 'string',
                    description: 'Category slug to resolve to. Must be a real ProductCategory slug.',
                  },
                  unless: {
                    ...categoryLookupCondition,
                    description: 'Condition that disqualifies this rule even when `when` matches.',
                  },
                },
                required: ['when', 'slug'],
                additionalProperties: false,
              },
            },
          },
          required: ['breadcrumbOrSource', 'slugLookup'],
          additionalProperties: false,
        },
        brand: pipelineRef('Pipeline producing the brand name.'),
        model: pipelineRef('Pipeline producing the model name.'),
        aliases: pipelineRef('Pipeline producing alternative names for this product.'),
        releaseYear: pipelineRef('Pipeline producing the model year.'),
        externalId: pipelineRef(
          'Pipeline producing the source-native listing id (SKU, model code, slug) — stable across URL changes. May be a group-level id shared by variant siblings.',
        ),
        siblingIds: pipelineRef(
          "Optional. Pipeline producing the ids of this product's other sizes, as the shop itself declares them (e.g. a frame-size variation list), in the same id space as externalId. May include this page's own id. Identity resolution looks them up within this source only, so every size the shop groups lands on one product. Configure it only from a list the shop declares — groupings inferred from shared images or article-number prefixes put different bikes together.",
        ),
        images: pipelineRef('Pipeline producing image URLs.'),
        specMapping: {
          type: 'object',
          description:
            'How this source\'s raw spec labels map onto the canonical category schema, keyed by category slug.',
          additionalProperties: { $ref: '#/$defs/sourceSpecConfig' },
        },
        offers: {
          type: 'object',
          description:
            'How offers are read off the page. Omit to opt this source out of offers entirely.',
          properties: {
            offerList: pipelineRef('Pipeline producing the collection of offers to iterate.'),
            itemMode: {
              enum: ['cheerio', 'json'],
              description:
                'How each entry of offerList is exposed to itemPipeline — as a single-element selection, or as a raw JSON value.',
            },
            itemPipeline: {
              allOf: [
                { $ref: '#/$defs/pipeline' },
                {
                  contains: { properties: { op: { const: 'assembleOffer' } }, required: ['op'] },
                },
              ],
              description:
                'Pipeline run once per offerList entry. Must terminate in an assembleOffer op, or it produces no offer.',
            },
          },
          required: ['offerList', 'itemMode', 'itemPipeline'],
          additionalProperties: false,
        },
        offerLinks: pipelineRef(
          'Pipeline producing links to sibling detail pages for the SAME product under a different URL — size/colour variants. These are fetched within the same scrape and folded into one product; no separate task is queued.',
        ),
        translation: {
          type: 'object',
          description: 'Per-source LLM translation of spec values.',
          properties: {
            enabled: { type: 'boolean', description: 'Whether translation runs.' },
            sourceLanguage: { type: 'string', description: 'ISO code of the source language.' },
            targetLanguage: { type: 'string', description: 'ISO code of the target language.' },
            contextTemplate: {
              type: 'string',
              description: 'Context given to the translator, with {{var}} interpolation.',
            },
          },
          required: ['enabled', 'sourceLanguage', 'targetLanguage', 'contextTemplate'],
          additionalProperties: false,
        },
        postProcess: postProcessConfigSchema,
      },
      required: ['rawSpecs', 'category', 'brand', 'model', 'images', 'specMapping'],
      additionalProperties: false,
    },
  },

  $defs: {
    pipeline: SCRAPE_PIPELINE_SCHEMA,
    operation: SCRAPE_OPERATION_SCHEMA,

    sourceSpecConfig: {
      type: 'object',
      description: 'How one category\'s specs are built from this source\'s raw labels.',
      properties: {
        mappings: {
          type: 'array',
          description: 'One entry per canonical spec key this source can supply.',
          items: { $ref: '#/$defs/sourceSpecMapping' },
        },
        calculated: {
          type: 'array',
          description: 'Specs derived from the mapped ones rather than read off the page.',
          items: { $ref: '#/$defs/calculatedSpecRule' },
        },
      },
      required: ['mappings'],
      additionalProperties: false,
    },

    sourceSpecMapping: {
      type: 'object',
      description: 'One canonical spec key and the raw labels that feed it.',
      properties: {
        key: {
          type: 'string',
          description:
            'Canonical spec key. Must exist in the category\'s jsonSchema.json, which this schema cannot check.',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Raw labels on this source that map to the key, in order of preference.',
        },
        sectionTitle: {
          type: 'string',
          description: 'Restrict matching to labels under this spec-table section.',
        },
        extract: {
          enum: [...SPEC_EXTRACT_MODES],
          description: 'How the raw value is converted. Defaults to "raw".',
        },
        extractPatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Regex sources used by the regexpList extract mode.',
        },
        trimSuffixes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Suffixes stripped from the raw value before conversion.',
        },
        replacePatterns: {
          type: 'array',
          description: 'Substitutions applied to the raw value.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Pattern to replace.' },
              to: { type: 'string', description: 'Replacement.' },
            },
            required: ['from', 'to'],
            additionalProperties: false,
          },
        },
        valueMap: {
          type: 'object',
          description:
            'Deterministic pre-translation remap: a raw value matching a key case-insensitively short-circuits translation entirely. Keeps closed-set categorical fields stable without LLM variance.',
          additionalProperties: { type: 'string' },
        },
        preferredValueIndex: {
          type: 'integer',
          minimum: 0,
          description: 'Which value to prefer when the label yields several.',
        },
        skipValues: {
          type: 'array',
          items: { type: 'string' },
          description: 'Raw values treated as absent.',
        },
      },
      required: ['key', 'labels'],
      additionalProperties: false,
    },

    calculatedSpecRule: {
      type: 'object',
      description: 'A spec derived from other specs rather than read off the page.',
      properties: {
        key: { type: 'string', description: 'Canonical spec key to write.' },
        rule: {
          enum: ['presentIfKey', 'featureSearch', 'presentLabels'],
          description: 'Which derivation to apply.',
        },
        source: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'The spec key(s) or label(s) the rule reads from.',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords the featureSearch rule looks for.',
        },
      },
      required: ['key', 'rule', 'source'],
      additionalProperties: false,
    },
  },
};

/**
 * Config schema for `type: 'arukereso'` — a product feed.
 *
 * Shares `$defs` with the scraping schema by value rather than by reference:
 * the two compile as independent Ajv validators, so a `$ref` across them would
 * not resolve.
 */
export const ARUKERESO_SOURCE_CONFIG_SCHEMA: JsonSchemaFragment = {
  $id: 'https://fittkereso.hu/schemas/arukereso-source-config.json',
  title: 'Árukereső product source config',
  description:
    'The complete definition of a type:"arukereso" source: where the feed is, how its fields map onto ours, and how its attributes map onto the category schema.',
  type: 'object',
  required: ['baseUrl', 'feedUrl', 'category', 'mapping'],
  additionalProperties: false,

  properties: {
    baseUrl: {
      type: 'string',
      description:
        "The shop's canonical base URL (scheme + host). Also exposed to pipelines as {{baseUrl}}.",
    },
    feedUrl: {
      type: 'string',
      description:
        'Where the feed is fetched from, over plain HTTP — never through the paid anti-bot scraper, which has no role in pulling a public file. For ShopRenter shops this is https://<shop>/api/?route=export/feed&id=arukereso.',
    },
    format: {
      enum: ['auto', 'xml', 'csv'],
      description:
        'Árukereső accepts exactly two format families: XML, and delimited text (CSV/TSV). "auto" sniffs the content type and the first bytes. Default: auto.',
    },
    csv: {
      type: 'object',
      description: 'Delimited-format options. Ignored when the format resolves to XML.',
      properties: {
        delimiter: {
          enum: ['auto', ',', ';', '\t'],
          description:
            'Árukereső permits comma, semicolon or tab. "auto" detects it from the header row. Default: auto.',
        },
      },
      additionalProperties: false,
    },

    maxItems: maxItemsSchema,
    filter: filterSchema,
    identityExtraction: identityExtractionSchema,

    categories: {
      type: 'object',
      description:
        'Which product categories this source is onboarded for, keyed by category slug.',
      additionalProperties: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description:
              'Whether feed items resolving to this category are imported. A feed is usually the whole catalog, so this gate is what keeps the rest out.',
          },
          sourceTitle: {
            type: 'string',
            description: 'What this shop calls the category. Informational.',
          },
        },
        required: ['enabled'],
        additionalProperties: false,
      },
    },

    category: {
      type: 'object',
      description: "How a feed item's category value resolves to one of our slugs.",
      properties: {
        labelFrom: pipelineRef(
          'Optional pipeline turning the raw category value into a matchable label — e.g. splitAndTake to pull "E-BIKE" out of "Termékkategóriák > E-BIKE > Trekking E-BIKE". Without it a full breadcrumb path can never satisfy an equalsIgnoreCase rule.',
        ),
        slugLookup: {
          type: 'array',
          description:
            'Rules tried in order; the first whose `when` matches and whose `unless` does not wins. Same vocabulary as detailPage.category.slugLookup, so a shop scraped AND fed can share rules verbatim.',
          items: {
            type: 'object',
            properties: {
              when: {
                ...categoryLookupCondition,
                description: 'Condition that selects this rule.',
              },
              slug: {
                type: 'string',
                description: 'Category slug to resolve to. Must be a real ProductCategory slug.',
              },
              unless: {
                ...categoryLookupCondition,
                description: 'Condition that disqualifies this rule even when `when` matches.',
              },
            },
            required: ['when', 'slug'],
            additionalProperties: false,
          },
        },
      },
      required: ['slugLookup'],
      additionalProperties: false,
    },

    mapping: {
      type: 'object',
      description:
        'Target field -> which feed field supplies it, with an optional transform. `field` does the addressing and the pipeline does the transforming, which is why this type needs no ops of its own.',
      required: ['brand', 'name', 'url', 'price'],
      // The target set is closed on purpose. A mapping key the importer does
      // not read would otherwise sit in the config looking effective while
      // silently doing nothing, which is exactly the failure a config author
      // cannot see from the outside.
      propertyNames: { enum: ARUKERESO_MAPPING_TARGETS as unknown as string[] },
      additionalProperties: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            description:
              'Feed field name, seeding the pipeline. Matched case-insensitively with _, - and spaces stripped — at least three spelling families exist in the wild for the same fields (ProductUrl / producturl / product_url), and the 2021 rename left the old names valid with no published mapping. Omit only when the pipeline needs no input, e.g. a `literal` currency code the format has no field for.',
          },
          pipeline: pipelineRef(
            'Optional transform, using the same op vocabulary as scraping configs.',
          ),
        },
        // One or the other must be there; `{}` is a mapping that does nothing.
        anyOf: [{ required: ['field'] }, { required: ['pipeline'] }],
        additionalProperties: false,
      },
    },

    specMapping: {
      type: 'object',
      description:
        "How the feed's attribute pairs map onto each category's canonical spec keys, keyed by category slug. Identical shape to detailPage.specMapping — an Árukereső feed's attribute labels are typically the same labels the shop's own spec table uses, so an existing mapping often transfers unchanged.",
      additionalProperties: { $ref: '#/$defs/sourceSpecConfig' },
    },

    postProcess: postProcessConfigSchema,
  },

  $defs: SCRAPING_SOURCE_CONFIG_SCHEMA['$defs'],
};
