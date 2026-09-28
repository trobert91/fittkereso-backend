import * as fs from 'fs';
import * as path from 'path';

interface SchemaProperty {
  type: string;
  meta?: { format?: string };
}

interface CategoryConfig {
  primarySpecs?: string[];
  matcherSpecs?: string[];
  matchingConfig?: { specMismatchPenalty?: Record<string, unknown> };
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

  it.each(penalties)('prices a mismatch on %s, a spec the gates compare', (key) => {
    expect(gated).toContain(key);
  });

  it.each(penalties)('prices a %s mismatch in points, 0 or more', (_key, points) => {
    expect(typeof points).toBe('number');
    expect(points).toBeGreaterThanOrEqual(0);
  });

  it.each(
    Object.entries(properties).filter(([, property]) => property.meta?.format),
  )('marks %s as a year only on a number field', (_key, property) => {
    expect(property.meta?.format).toBe('year');
    expect(property.type).toBe('number');
  });
});
