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

export const PRODUCT_SOURCE_CONFIG_SCHEMA: JsonSchemaFragment = {
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
  $id: 'https://fittkereso.hu/schemas/product-source-config.json',
  title: 'Product source config',
  description:
    'The complete declarative definition of how to scrape one source: where to fetch from, how to discover products, how to parse list and detail pages, and how to map raw specs onto the category schema.',
  type: 'object',
  required: ['baseUrl', 'listPage', 'detailPage'],
  additionalProperties: false,

  properties: {
    baseUrl: {
      type: 'string',
      description:
        'The site\'s canonical base URL (scheme + host), e.g. https://www.example.com. Also exposed to pipelines as {{baseUrl}}.',
    },
    fullSyncStartUrl: {
      type: 'string',
      description:
        'Where a full catalog crawl starts — typically an "all products" or category index page. Defaults to baseUrl when omitted.',
    },

    discovery: {
      type: 'object',
      description:
        'How a full sync finds category/list pages to crawl. A source without this section does no full sync at all.',
      properties: {
        mode: {
          enum: ['categoryTitleMatch', 'brandNameMatch'],
          description:
            '"categoryTitleMatch" keeps links whose title matches the enabled categories\' sourceTitle values; "brandNameMatch" keeps links matching known brand names.',
        },
        linkPipeline: pipelineRef(
          'Pipeline run against the discovery page, producing the list-page links to crawl.',
        ),
      },
      required: ['mode', 'linkPipeline'],
      additionalProperties: false,
    },

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

    incrementalSync: {
      type: 'object',
      description:
        'How the "what is new" pass finds recently published product pages, via Exa search rather than a crawl.',
      properties: {
        searchKeywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'One search is run per keyword, restricted to this source\'s domain.',
        },
        numResults: {
          type: 'integer',
          minimum: 1,
          description: 'Results requested per keyword. Defaults to 40.',
        },
        urlClassify: {
          type: 'object',
          description: 'How a search result URL is recognised as a product detail page.',
          properties: {
            detailUrlPattern: {
              type: 'string',
              description:
                'Regex a URL must match to be queued as a detail page. Compiled with `new RegExp`, so it must be a valid pattern.',
            },
          },
          required: ['detailUrlPattern'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },

    listPage: {
      type: 'object',
      description: 'How a category/list page is parsed.',
      properties: {
        categoryName: pipelineRef('Pipeline producing this page\'s category name.'),
        categoryLinks: pipelineRef(
          'Pipeline producing further list-page links — pagination and sub-categories. Each becomes another list task.',
        ),
        productLinks: pipelineRef(
          'Pipeline producing product detail links. Each becomes a detail task.',
        ),
      },
      required: ['categoryName', 'categoryLinks', 'productLinks'],
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
        postProcess: {
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
                'Whether detailPage.description reaches the offer-identity call. Defaults to false — that call reconciles brand/model/size/colour, which a marketing blurb rarely states better than the title.',
            },
            includeDescriptionInModelSpecs: {
              type: 'boolean',
              description:
                'Whether detailPage.description reaches the model-spec call. Defaults to true. Set false for a source whose description is pure sales copy.',
            },
          },
          additionalProperties: false,
        },
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
