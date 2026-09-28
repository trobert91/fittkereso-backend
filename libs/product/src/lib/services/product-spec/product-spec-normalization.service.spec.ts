import type { SpecDefinitionJsonSchema } from '@fittkereso-backend/database';
import { ProductSpecNormalizationService } from './product-spec-normalization.service';

describe('ProductSpecNormalizationService', () => {
  const service = new ProductSpecNormalizationService();
  const schema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {
      modelYear: { type: 'number', title: 'Model year', meta: { format: 'year' } },
      wheelSize: { type: 'number', title: 'Wheel size' },
    },
  };

  it.each([[2026], ['2026'], ['26'], ["'26"], ['’26'], ['2026.']])(
    'reads the year field %p as 2026',
    (raw) => {
      expect(service.normalize({ modelYear: raw }, schema)).toEqual({ modelYear: 2026 });
    },
  );

  // Its first number is the rule for every other number field.
  it('keeps the first number of a field that is not a year', () => {
    expect(service.normalize({ wheelSize: '26 col' }, schema)).toEqual({ wheelSize: 26 });
  });

  it('leaves a year that is not one year without a value', () => {
    expect(service.normalize({ modelYear: '2025/2026' }, schema)).toEqual({
      modelYear: undefined,
    });
  });
});
