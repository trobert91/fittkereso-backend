import * as fs from 'fs';
import * as path from 'path';

interface SchemaProperty {
  type: string;
  enum?: unknown[];
  meta?: { min?: number; max?: number };
}

// Every category directory holding both files. Read from disk rather than
// imported, so a new category is covered without touching this spec.
const categories = fs
  .readdirSync(__dirname, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter(
    (slug) =>
      fs.existsSync(path.join(__dirname, slug, 'goldenSample.json')) &&
      fs.existsSync(path.join(__dirname, slug, 'jsonSchema.json')),
  );

const read = (slug: string, file: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, slug, file), 'utf8'));

/**
 * The golden sample is shown to full spec unification as the example of a
 * correctly unified product, so the model copies its values' shape and, all
 * too readily, the values themselves. A value the schema forbids is taught to
 * every call; the schema is the contract, the sample only illustrates it.
 */
describe.each(categories)('the %s golden sample', (slug) => {
  const golden: Record<string, unknown> = read(slug, 'goldenSample.json');
  const properties: Record<string, SchemaProperty> = read(slug, 'jsonSchema.json')
    .properties;
  const entries = Object.entries(golden);

  it.each(entries)('%s is a field of the schema', (key) => {
    expect(properties[key]).toBeDefined();
  });

  it.each(entries)('%s has the type the schema declares', (key, value) => {
    const property = properties[key];
    if (!property) return;
    expect(Array.isArray(value) ? 'array' : typeof value).toBe(property.type);
  });

  it.each(entries.filter(([key]) => properties[key]?.enum?.length))(
    '%s is one of the allowed values',
    (key, value) => {
      expect(properties[key].enum).toContain(value);
    },
  );

  it.each(
    entries.filter(
      ([key, value]) =>
        typeof value === 'number' &&
        (properties[key]?.meta?.min !== undefined ||
          properties[key]?.meta?.max !== undefined),
    ),
  )('%s is within the schema range', (key, value) => {
    const { min = -Infinity, max = Infinity } = properties[key].meta ?? {};
    expect(value).toBeGreaterThanOrEqual(min);
    expect(value).toBeLessThanOrEqual(max);
  });
});
