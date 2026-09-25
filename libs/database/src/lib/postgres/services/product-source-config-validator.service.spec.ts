import { ProductSourceConfigValidatorService } from './product-source-config-validator.service';

/** The smallest config the schema accepts. Each test mutates a clone of it. */
const MINIMAL_CONFIG = {
  baseUrl: 'https://example.com',
  startUrls: ['https://example.com/products'],
  listPage: {
    categoryName: [{ op: 'selectText', selector: 'h1', first: true }],
    items: [{ op: 'selectAll', selector: 'a.product' }],
    itemMode: 'cheerio',
    itemPipeline: [
      {
        op: 'assembleListProduct',
        url: [{ op: 'selectAttr', selector: 'a', attr: 'href', within: 'item' }],
      },
    ],
  },
  detailPage: {
    rawSpecs: [{ op: 'selectAll', selector: 'tr' }],
    category: {
      breadcrumbOrSource: [{ op: 'selectText', selector: '.crumb' }],
      slugLookup: [{ when: { always: true }, slug: 'ebikes' }],
    },
    brand: [{ op: 'selectText', selector: '.brand' }],
    model: [{ op: 'selectText', selector: '.model' }],
    images: [{ op: 'extractAttrList', attr: 'src' }],
    specMapping: {
      ebikes: { mappings: [{ key: 'motorBrand', labels: ['Motor'] }] },
    },
  },
};

describe('ProductSourceConfigValidatorService', () => {
  let validator: ProductSourceConfigValidatorService;

  beforeEach(() => {
    validator = new ProductSourceConfigValidatorService();
  });

  const configWith = (mutate: (config: any) => void): unknown => {
    const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
    mutate(config);
    return config;
  };

  const messageFor = (config: unknown): string => {
    const problems = validator.problems('scraping', config);
    return problems ? validator.format(problems) : '';
  };

  it('accepts a minimal valid config', () => {
    expect(validator.problems('scraping', MINIMAL_CONFIG)).toBeNull();
  });

  it('rejects an unknown op name and names the offending value', () => {
    const message = messageFor(
      configWith((c) => {
        c.listPage.items[0].op = 'selectTxt';
      }),
    );

    expect(message).toContain('/listPage/items/0/op');
    expect(message).toContain('"selectTxt"');
  });

  // The whole reason the schema uses unevaluatedProperties rather than
  // additionalProperties — the latter cannot see through the discriminated
  // allOf and would reject every op parameter as unknown.
  it('rejects a misspelled parameter on an otherwise valid op', () => {
    const message = messageFor(
      configWith((c) => {
        c.listPage.items[0] = { op: 'selectAll', selectr: '.product' };
      }),
    );

    expect(message).toContain("must have required property 'selector'");
    expect(message).toContain('"selectr"');
  });

  it('rejects a missing required parameter', () => {
    const message = messageFor(
      configWith((c) => {
        c.listPage.items[0] = { op: 'selectAll' };
      }),
    );

    expect(message).toContain("must have required property 'selector'");
  });

  it('rejects an unknown top-level key', () => {
    const message = messageFor(
      configWith((c) => {
        c.baseUrlTypo = 'https://example.com';
      }),
    );

    expect(message).toContain('"baseUrlTypo"');
  });

  it('rejects a missing required section', () => {
    const message = messageFor(
      configWith((c) => {
        delete c.detailPage.brand;
      }),
    );

    expect(message).toContain("must have required property 'brand'");
  });

  it('lists the allowed values for a short enum', () => {
    const message = messageFor(
      configWith((c) => {
        c.detailPage.offers = {
          offerList: [{ op: 'selectAll', selector: '.offer' }],
          itemMode: 'jsonn',
          itemPipeline: [{ op: 'assembleOffer', price: [{ op: 'trim' }] }],
        };
      }),
    );

    expect(message).toContain('"cheerio"');
    expect(message).toContain('"json"');
  });

  // 53 op names would bury the one word that matters, so the op enum reports
  // the offending value instead of the allowed set.
  it('does not list all allowed values for the op enum', () => {
    const message = messageFor(
      configWith((c) => {
        c.listPage.items[0].op = 'nope';
      }),
    );

    expect(message).toContain('"nope"');
    expect(message).not.toContain('extractSpecTableV1');
  });

  describe('nested pipelines', () => {
    it('validates inside forEachItem', () => {
      const message = messageFor(
        configWith((c) => {
          c.detailPage.rawSpecs = [
            { op: 'forEachItem', itemMode: 'json', itemPipeline: [{ op: 'bogus' }] },
          ];
        }),
      );

      expect(message).toContain('/detailPage/rawSpecs/0/itemPipeline/0/op');
    });

    it('validates inside both branch arms', () => {
      const message = messageFor(
        configWith((c) => {
          c.detailPage.rawSpecs = [
            {
              op: 'branch',
              condition: { isEmpty: 'x' },
              ifTrue: [],
              ifFalse: [{ op: 'bogus' }],
            },
          ];
        }),
      );

      expect(message).toContain('/detailPage/rawSpecs/0/ifFalse/0/op');
    });

    it('validates inside an assembleOffer sub-pipeline', () => {
      const message = messageFor(
        configWith((c) => {
          c.detailPage.offers = {
            offerList: [{ op: 'selectAll', selector: '.offer' }],
            itemMode: 'cheerio',
            itemPipeline: [{ op: 'assembleOffer', price: [{ op: 'bogus' }] }],
          };
        }),
      );

      expect(message).toContain('/detailPage/offers/itemPipeline/0/price/0/op');
    });

    // A bad op nested in assembleOffer also fails that assembleOffer's own
    // branch, which would otherwise report every one of its parameters as
    // unevaluated on top of the real error.
    it('reports a nested bad op once, without unevaluated-property noise', () => {
      const message = messageFor(
        configWith((c) => {
          c.detailPage.offers = {
            offerList: [{ op: 'selectAll', selector: '.offer' }],
            itemMode: 'cheerio',
            itemPipeline: [{ op: 'assembleOffer', price: [{ op: 'bogus' }] }],
          };
        }),
      );

      expect(message).not.toContain('unevaluated');
    });
  });

  it('requires an assembleOffer somewhere in an offer item pipeline', () => {
    const message = messageFor(
      configWith((c) => {
        c.detailPage.offers = {
          offerList: [{ op: 'selectAll', selector: '.offer' }],
          itemMode: 'cheerio',
          itemPipeline: [{ op: 'trim' }],
        };
      }),
    );

    expect(message).toContain('/detailPage/offers/itemPipeline');
  });

  it('rejects a runtime data source outside the fixed set', () => {
    const message = messageFor(
      configWith((c) => {
        c.listPage.items[0] = {
          op: 'matchAgainstRuntimeList',
          source: 'runtime:anything',
          field: 'title',
        };
      }),
    );

    expect(message).toContain('/listPage/items/0/source');
  });

  it('rejects an unknown spec extract mode', () => {
    const message = messageFor(
      configWith((c) => {
        c.detailPage.specMapping.ebikes.mappings[0].extract = 'numberr';
      }),
    );

    expect(message).toContain('extract');
  });

  it('rejects a category lookup rule with no condition', () => {
    const message = messageFor(
      configWith((c) => {
        c.detailPage.category.slugLookup = [{ when: {}, slug: 'ebikes' }];
      }),
    );

    expect(message).toContain('/detailPage/category/slugLookup/0/when');
  });

  describe('assertValid', () => {
    it('does not throw for a valid config', () => {
      expect(() => validator.assertValid('scraping', MINIMAL_CONFIG)).not.toThrow();
    });

    it('throws naming the bad path', () => {
      expect(() =>
        validator.assertValid('scraping',
          configWith((c) => {
            c.listPage.items[0].op = 'selectTxt';
          }),
        ),
      ).toThrow(/listPage\/items\/0\/op/);
    });

    it('rejects a non-object outright', () => {
      expect(() => validator.assertValid('scraping', 'not a config')).toThrow();
      expect(() => validator.assertValid('scraping', null)).toThrow();
    });
  });

  it('caps how many problems one report carries', () => {
    const problems = validator.problems('scraping', { baseUrl: 'https://example.com' }) ?? [];

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.length).toBeLessThanOrEqual(11);
  });

  it('exposes the schema for the config editor', () => {
    expect(validator.schemaFor('scraping')).toMatchObject({ type: 'object' });
  });

  describe('feed sources', () => {
    const strip = [{ op: 'stripPattern', pattern: '\\s*[A-Z]{3}$' }];
    const feedConfig = (mapping: Record<string, unknown> = {}) => ({
      baseUrl: 'https://speedbike.hu',
      feedUrl: 'https://speedbike.hu/api/?route=export/feed&id=google_shopping',
      category: { slugLookup: [{ when: { always: true }, slug: 'ebikes' }] },
      mapping: {
        brand: { field: 'brand' },
        name: { field: 'title' },
        url: { field: 'link' },
        price: { field: 'price', pipeline: strip },
        ...mapping,
      },
    });

    it('validates a googleshop source against the feed schema', () => {
      expect(validator.schemaFor('googleshop')).toBe(validator.schemaFor('arukereso'));
      expect(validator.problems('googleshop', feedConfig())).toBeNull();
      expect(validator.problems('googleshop', MINIMAL_CONFIG)).not.toBeNull();
    });

    it('accepts a list of fallbacks for a target', () => {
      const config = feedConfig({
        price: [
          { field: 'sale_price', pipeline: strip },
          { field: 'price', pipeline: strip },
        ],
      });

      expect(validator.problems('googleshop', config)).toBeNull();
      expect(validator.problems('arukereso', config)).toBeNull();
    });

    it('rejects an empty fallback list, and a bad entry inside one', () => {
      expect(validator.problems('googleshop', feedConfig({ price: [] }))).not.toBeNull();
      expect(
        validator.problems('googleshop', feedConfig({ price: [{ field: 'price' }, { feild: 'sale_price' }] })),
      ).not.toBeNull();
      expect(validator.problems('googleshop', feedConfig({ price: [{ field: 'price' }, {}] }))).not.toBeNull();
    });
  });
});
