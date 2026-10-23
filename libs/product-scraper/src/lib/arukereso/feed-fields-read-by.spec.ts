import { ArukeresoSourceConfig } from '@fittkereso-backend/database';
import { feedFieldsReadBy } from './feed-fields-read-by';

describe('feedFieldsReadBy', () => {
  const config = {
    baseUrl: 'https://shop.example',
    feedUrl: 'https://shop.example/feed.xml',
    mapping: {
      externalId: { field: 'identifier' },
      name: { field: 'Name' },
      price: [{ field: 'sale_price' }, { field: 'Price' }],
      currency: { pipeline: [{ op: 'literal', value: 'HUF' }] },
      categoryLabel: { field: 'category' },
    },
    filter: {
      conditions: [
        { field: 'manufacturer', in: ['KTM'] },
        { field: 'attribute:Motor gyártó', equals: 'Bosch' },
      ],
    },
    categories: {
      ebikes: {
        enabled: true,
        extraSpecRows: [{ label: 'Kategória', field: 'category' }, { label: 'Kód', pipeline: [] }],
      },
    },
  } as unknown as ArukeresoSourceConfig;

  const readers = feedFieldsReadBy(config);

  it('reads every mapping field, fallbacks included, in any spelling', () => {
    expect(readers.readersOf('Identifier')).toEqual(['mapping.externalId']);
    expect(readers.readersOf('SalePrice')).toEqual(['mapping.price']);
    expect(readers.readersOf('price')).toEqual(['mapping.price']);
    expect(readers.readersOf('product_name')).toEqual([]);
  });

  it('collects every reader of a column read twice', () => {
    expect(readers.readersOf('category')).toEqual([
      'mapping.categoryLabel',
      'extraSpecRows.ebikes:Kategória',
    ]);
  });

  it('reads filter columns, and keeps attribute: conditions apart', () => {
    expect(readers.readersOf('manufacturer')).toEqual(['filter']);
    expect(readers.filterAttributes).toEqual(new Set(['motorgyártó']));
    expect(readers.readersOf('attribute:Motor gyártó')).toEqual([]);
  });

  it('ignores a mapping or extra row without a field', () => {
    expect([...readers.fields.keys()].sort()).toEqual([
      'category',
      'identifier',
      'manufacturer',
      'name',
      'price',
      'saleprice',
    ]);
  });
});
