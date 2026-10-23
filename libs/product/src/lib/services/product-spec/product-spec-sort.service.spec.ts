import { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductSpecs } from '@fittkereso-backend/database';
import { ProductSpecSortService } from './product-spec-sort.service';

describe('ProductSpecSortService', () => {
  const schema = {
    properties: {
      cassetteRange: { type: 'string', title: 'Cassette range', meta: { order: 1, unit: 'T', unitFormat: 'none' } },
      weight: { type: 'number', title: 'Weight', meta: { order: 2, unit: 'kg' } },
    },
  };
  const service = new ProductSpecSortService({
    getJsonSchema: () => schema,
  } as unknown as CategoryConfigService);
  const values = (specs: ProductSpecs) =>
    Object.fromEntries(service.sortSpecs('bikes', specs).map((spec) => [spec.key, spec.value]));

  it('appends the unit, without a space for unitFormat none', () => {
    expect(values({ cassetteRange: '11-50', weight: 24.5 })).toEqual({ cassetteRange: '11-50T', weight: '24.5 kg' });
  });

  it('does not repeat a unit the value already carries', () => {
    expect(values({ cassetteRange: '11-50T' })).toEqual({ cassetteRange: '11-50T' });
  });
});
