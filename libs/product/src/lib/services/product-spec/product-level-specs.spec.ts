import type { SpecDefinitionJsonSchema } from '@fittkereso-backend/database';
import {
  getVerbatimSpecKeys,
  getYearSpecKeys,
  normalizeYearSpecs,
} from './product-level-specs';

describe('normalizeYearSpecs', () => {
  const schema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {
      modelYear: { type: 'number', title: 'Model year', meta: { format: 'year' } },
      wheelSize: { type: 'number', title: 'Wheel size' },
      motorModel: { type: 'string', title: 'Motor model' },
    },
  };

  it('finds the year fields by their schema format, not by name', () => {
    expect(getYearSpecKeys(schema)).toEqual(['modelYear']);
  });

  it('converts a year field and leaves every other key as it was', () => {
    expect(
      normalizeYearSpecs(
        { modelYear: "'26", wheelSize: '29', motorModel: 'Bosch CX 2026' },
        schema,
      ),
    ).toEqual({ modelYear: 2026, wheelSize: '29', motorModel: 'Bosch CX 2026' });
  });

  it('drops a year that is not one year, rather than store a guess', () => {
    expect(normalizeYearSpecs({ modelYear: '2025/2026', wheelSize: 29 }, schema)).toEqual({
      wheelSize: 29,
    });
  });

  it('returns the same object when there is no year to convert', () => {
    const specs = { wheelSize: 29 };
    expect(normalizeYearSpecs(specs, schema)).toBe(specs);
    const noYearFields = { ...schema, properties: { wheelSize: schema.properties['wheelSize'] } };
    const withYear = { modelYear: '26' };
    expect(normalizeYearSpecs(withYear, noYearFields)).toBe(withYear);
  });
});

describe('getVerbatimSpecKeys', () => {
  const schema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {
      frameSize: { type: 'number', title: 'Frame size' },
      frameSizeLabel: {
        type: 'string',
        title: 'Frame size label',
        enum: ['S', 'M', 'L'],
      },
      color: { type: 'string', title: 'Color' },
      motorModel: { type: 'string', title: 'Motor model' },
    },
  };

  it('keeps the free-text offer-level keys: a number is parsed, and a fixed list mapped onto', () => {
    expect(
      getVerbatimSpecKeys(schema, ['frameSize', 'frameSizeLabel', 'color']),
    ).toEqual(['color']);
  });

  it('only ever picks from the offer-level keys it is given', () => {
    expect(getVerbatimSpecKeys(schema, ['frameSize'])).toEqual([]);
  });

  it('skips a key the schema does not define', () => {
    expect(getVerbatimSpecKeys(schema, ['finish', 'color'])).toEqual(['color']);
  });
});
