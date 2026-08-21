import { ProductSpecValidatorService } from './product-spec-validator.service';
import type { SpecDefinitionJsonSchema } from '@fittkereso-backend/database';

describe('ProductSpecValidatorService.validateSpecs', () => {
  let service: ProductSpecValidatorService;

  const schema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {
      weight: { type: 'number', title: 'Weight' } as any,
      frameType: {
        type: 'string',
        title: 'Frame type',
        enum: ['Diamond', 'Step-through'],
      } as any,
    },
  };

  beforeEach(() => {
    service = new ProductSpecValidatorService();
  });

  it('is valid with no schema (nothing to check against)', () => {
    const result = service.validateSpecs(undefined, { weight: 22 });
    expect(result).toEqual({ isValid: true, errors: {} });
  });

  it('is valid when specs match the schema', () => {
    const result = service.validateSpecs(schema, {
      weight: 22,
      frameType: 'Diamond',
    });
    expect(result.isValid).toBe(true);
  });

  it('reports a type mismatch keyed by field name', () => {
    const result = service.validateSpecs(schema, { weight: 'not-a-number' } as any);
    expect(result.isValid).toBe(false);
    expect(result.errors['weight']).toBeDefined();
  });

  it('allows unknown keys by default (schema has no additionalProperties)', () => {
    // Matches the stored category jsonSchema.json files, which intentionally
    // omit additionalProperties — scrape-time validation is informational
    // only and must tolerate source-mapping drift.
    const result = service.validateSpecs(schema, {
      test: false,
      test2: false,
    } as any);
    expect(result.isValid).toBe(true);
  });

  it('rejects unknown keys and reports them by field name when additionalProperties is false', () => {
    const strictSchema = { ...schema, additionalProperties: false };
    const result = service.validateSpecs(strictSchema, {
      test: false,
      test2: false,
    } as any);

    expect(result.isValid).toBe(false);
    expect(result.errors['test']).toEqual(['unknown field "test"']);
    expect(result.errors['test2']).toEqual(['unknown field "test2"']);
  });
});
