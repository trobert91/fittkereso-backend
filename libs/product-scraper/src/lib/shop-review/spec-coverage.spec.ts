import { ProductCategoryConfig, SpecKeyCountRow } from '@fittkereso-backend/database';
import { buildSpecCoverage, specKeyTags } from './spec-coverage';

const row = (layer: SpecKeyCountRow['layer'], key: string, count: number): SpecKeyCountRow => ({
  sourceId: 's1',
  slug: 'ebikes',
  layer,
  key,
  count,
});

const config = {
  primarySpecs: ['torque', 'batteryCapacity'],
  matcherSpecs: ['batteryCapacity'],
  offerLevelSpecs: ['frameSize'],
  filterSpecs: [{ key: 'torque', filterType: 'range' }],
} as unknown as ProductCategoryConfig;

describe('specKeyTags', () => {
  it('tags each key with every role the category config gives it', () => {
    const tags = specKeyTags(config);
    expect(tags.get('torque')).toEqual(['primary', 'filter']);
    expect(tags.get('batteryCapacity')).toEqual(['primary', 'matcher']);
    expect(tags.get('frameSize')).toEqual(['offer']);
    expect(tags.get('color')).toBeUndefined();
  });
});

describe('buildSpecCoverage', () => {
  const coverage = buildSpecCoverage({
    slug: 'ebikes',
    listings: 10,
    products: 8,
    schemaKeys: ['torque', 'batteryCapacity', 'frameSize', 'color', 'chain'],
    config,
    rows: [
      row('extracted', 'torque', 9),
      row('specs', 'torque', 10),
      row('product', 'torque', 8),
      row('extracted', 'batteryCapacity', 1),
      row('specs', 'batteryCapacity', 7),
      row('offer', 'frameSize', 10),
      row('specs', 'color', 5),
      row('extracted', 'legacyKey', 10),
    ],
  });

  it('lists every schema key in schema order with its counts, and nothing outside the schema', () => {
    expect(coverage.keys.map((key) => key.key)).toEqual([
      'torque',
      'batteryCapacity',
      'frameSize',
      'color',
      'chain',
    ]);
    expect(coverage.keys[0]).toEqual({
      key: 'torque',
      tags: ['primary', 'filter'],
      extracted: 9,
      specs: 10,
      offer: 0,
      product: 8,
    });
  });

  it('names the keys no layer fills', () => {
    expect(coverage.neverFilled).toEqual(['chain']);
  });

  it('names the keys the LLM fills where the mapping mostly does not', () => {
    // batteryCapacity: 10% by mapping, 70% after the LLM. color: 50%, under the bar.
    expect(coverage.llmOnly).toEqual(['batteryCapacity']);
  });

  it('reports no LLM-only key when there are no listings', () => {
    const empty = buildSpecCoverage({
      slug: 'bikes',
      listings: 0,
      products: 0,
      schemaKeys: ['torque'],
      config: undefined,
      rows: [],
    });
    expect(empty.llmOnly).toEqual([]);
    expect(empty.neverFilled).toEqual(['torque']);
  });
});
