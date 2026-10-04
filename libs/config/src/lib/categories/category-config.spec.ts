import * as fs from 'fs';
import * as path from 'path';

interface SchemaProperty {
  type: string;
  enum?: string[];
  meta?: { format?: string };
}

interface CategoryConfig {
  primarySpecs?: string[];
  matcherSpecs?: string[];
  offerLevelSpecs?: string[];
  matchingConfig?: {
    specMismatchPenalty?: Record<string, unknown>;
    compatibleValues?: Record<string, Record<string, string[]>>;
    model?: {
      excludeSpecs?: string[];
      examples?: { title: string; model: string }[];
    };
  };
  brandIdentifierSpecs?: Record<
    string,
    { spec: string; identifier: string; pattern: string; prefix?: string }[]
  >;
}

// Every category directory holding both files. Read from disk rather than
// imported, so a new category is covered without touching this spec.
const categories = fs
  .readdirSync(__dirname, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter(
    (slug) =>
      fs.existsSync(path.join(__dirname, slug, 'config.json')) &&
      fs.existsSync(path.join(__dirname, slug, 'jsonSchema.json')),
  );

const read = (slug: string, file: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, slug, file), 'utf8'));

/**
 * Settings the code reads by key and silently ignores when a key is wrong: a
 * mistyped spec name in `specMismatchPenalty` charges nothing and says nothing,
 * and a year marker on a text field converts nothing.
 */
describe.each(categories)('the %s category config', (slug) => {
  const config: CategoryConfig = read(slug, 'config.json');
  const properties: Record<string, SchemaProperty> = read(slug, 'jsonSchema.json')
    .properties;
  const gated = [...(config.primarySpecs ?? []), ...(config.matcherSpecs ?? [])];
  const penalties = Object.entries(config.matchingConfig?.specMismatchPenalty ?? {});
  const keyExcludes = config.matchingConfig?.model?.excludeSpecs ?? [];
  const compatibleValues = Object.entries(config.matchingConfig?.compatibleValues ?? {});

  it.each(keyExcludes)('leaves %s out of the model, a field of the schema', (key) => {
    expect(Object.keys(properties)).toContain(key);
  });

  // The offer-level specs are always left out; listing one again only hides
  // that the two lists can drift apart.
  it.each(keyExcludes)('lists %s only once, outside the offer-level specs', (key) => {
    expect(config.offerLevelSpecs ?? []).not.toContain(key);
  });

  // The prompt tells the LLM to keep only the title's own words, in order; an
  // example that breaks the rule teaches it to.
  it.each(
    (config.matchingConfig?.model?.examples ?? []).map(
      (example) => [example.model, example] as const,
    ),
  )("shows a model of the title's own words, in order: %s", (_name, example) => {
    const titleWords = example.title.split(/\s+/);
    let from = 0;
    for (const word of example.model.split(/\s+/)) {
      const at = titleWords.indexOf(word, from);
      expect(at).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
  });

  it.each(penalties)('prices a mismatch on %s, a spec the gates compare', (key) => {
    expect(gated).toContain(key);
  });

  it.each(penalties)('prices a %s mismatch in points, 0 or more', (_key, points) => {
    expect(typeof points).toBe('number');
    expect(points).toBeGreaterThanOrEqual(0);
  });

  it.each(compatibleValues)('lists compatible values of %s, a spec the gates compare', (key) => {
    expect(gated).toContain(key);
  });

  // A listed value off the field's list never reaches a product, so it would
  // never apply. The entry's own value may also be another spelling of an
  // allowed one ("Unisex" beside "Uniszex"). Compared as the gates compare,
  // ignoring case.
  it.each(compatibleValues)('lists only allowed values of %s as compatible', (key, entries) => {
    const allowed = properties[key]?.enum?.map((value) => value.toLowerCase());
    if (!allowed) return;
    for (const compatibles of Object.values(entries)) {
      for (const compatible of compatibles) expect(allowed).toContain(compatible.toLowerCase());
    }
  });

  const brandRules = Object.entries(config.brandIdentifierSpecs ?? {}).flatMap(([brand, rules]) =>
    rules.map((rule) => [`${brand} ${rule.spec} ${rule.pattern}`, rule] as const),
  );

  it.each(brandRules)('fills a field of the schema from a brand identifier: %s', (_name, rule) => {
    expect(Object.keys(properties)).toContain(rule.spec);
    expect(['mpn', 'gtin']).toContain(rule.identifier);
  });

  // The value is the first group; a pattern with none (or a second one)
  // reads nothing or the wrong digits, silently.
  it.each(brandRules)('reads one capture group off a brand identifier: %s', (_name, rule) => {
    const groups = new RegExp(`${rule.pattern}|`).exec('')?.length ?? 0;
    expect(groups - 1).toBe(1);
  });

  it.each(
    Object.entries(properties).filter(([, property]) => property.meta?.format),
  )('marks %s as a year only on a number field', (_key, property) => {
    expect(property.meta?.format).toBe('year');
    expect(property.type).toBe('number');
  });
});
