import type {
  ProductSourceRecordRepository,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import type { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductSourceRecordSearchService } from './product-source-record-search.service';

const EBIKE_SCHEMA = {
  title: 'E-bike',
  type: 'object',
  properties: {
    frameSize: { type: 'string', title: 'Frame size' },
    wheelSize: { type: 'number', title: 'Wheel size', meta: { unit: 'inch' } },
    color: { type: 'string', title: 'Color' },
  },
} satisfies SpecDefinitionJsonSchema;

function serviceWith(result: { items: unknown[]; total: number }) {
  const searchRecords = jest.fn().mockResolvedValue(result);
  const getJsonSchema = jest.fn((slug?: string | null) =>
    slug === 'ebikes' ? EBIKE_SCHEMA : undefined,
  );
  const service = new ProductSourceRecordSearchService(
    { searchRecords } as unknown as ProductSourceRecordRepository,
    { getJsonSchema } as unknown as CategoryConfigService,
  );
  return { service, searchRecords };
}

describe('ProductSourceRecordSearchService', () => {
  it('turns the page into an offset and passes the filters on, blank texts dropped', async () => {
    const { service, searchRecords } = serviceWith({ items: [], total: 0 });

    await service.search({
      sourceIds: ['source-1'],
      attached: false,
      valid: true,
      search: '  ',
      productName: ' macina ',
      categoryIds: ['category-1'],
      page: 3,
      pageSize: 20,
      sort: 'price',
      order: 'ASC',
    });

    expect(searchRecords).toHaveBeenCalledWith({
      productSourceIds: ['source-1'],
      attached: false,
      valid: true,
      search: undefined,
      productName: 'macina',
      brand: undefined,
      categoryIds: ['category-1'],
      sort: 'price',
      order: 'ASC',
      skip: 40,
      take: 20,
    });
  });

  it('answers with the page, the totals and the sort it used', async () => {
    const { service } = serviceWith({
      items: [{ id: 'record-1', offerEntrySpecs: [] }],
      total: 51,
    });

    const result = await service.search({});

    expect(result).toEqual(
      expect.objectContaining({
        page: 1,
        pageSize: 50,
        totalItems: 51,
        totalPages: 2,
        items: [{ id: 'record-1', offerSpecs: [] }],
        sort: 'seenAt',
        order: 'DESC',
      }),
    );
  });

  it("sums up each listing's offer entry specs, labelled and ordered by its category's schema", async () => {
    const { service } = serviceWith({
      items: [
        {
          id: 'record-1',
          categorySlug: 'ebikes',
          offerEntrySpecs: [
            { color: 'Black', frameSize: 'M', wheelSize: 29, batteryBrand: 'Bosch' },
            { color: 'Black', frameSize: 'L', wheelSize: 29, notes: '' },
          ],
        },
      ],
      total: 1,
    });

    const { items } = await service.search({});

    expect(items?.[0]).toEqual({
      id: 'record-1',
      categorySlug: 'ebikes',
      offerSpecs: [
        { key: 'frameSize', label: 'Frame size', unit: undefined, values: ['M', 'L'] },
        { key: 'wheelSize', label: 'Wheel size', unit: 'inch', values: [29] },
        { key: 'color', label: 'Color', unit: undefined, values: ['Black'] },
        { key: 'batteryBrand', label: 'batteryBrand', unit: undefined, values: ['Bosch'] },
      ],
    });
  });

  it('keeps the keys as labels when the category has no schema', async () => {
    const { service } = serviceWith({
      items: [{ id: 'record-1', categorySlug: null, offerEntrySpecs: [{ size: 'S' }] }],
      total: 1,
    });

    const { items } = await service.search({});

    expect(items?.[0].offerSpecs).toEqual([
      { key: 'size', label: 'size', unit: undefined, values: ['S'] },
    ]);
  });
});
