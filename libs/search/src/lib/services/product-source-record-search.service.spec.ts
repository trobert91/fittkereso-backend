import type { ProductSourceRecordRepository } from '@fittkereso-backend/database';
import { ProductSourceRecordSearchService } from './product-source-record-search.service';

function serviceWith(result: { items: unknown[]; total: number }) {
  const searchRecords = jest.fn().mockResolvedValue(result);
  const service = new ProductSourceRecordSearchService({
    searchRecords,
  } as unknown as ProductSourceRecordRepository);
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
    const { service } = serviceWith({ items: [{ id: 'record-1' }], total: 51 });

    const result = await service.search({});

    expect(result).toEqual(
      expect.objectContaining({
        page: 1,
        pageSize: 50,
        totalItems: 51,
        totalPages: 2,
        items: [{ id: 'record-1' }],
        sort: 'seenAt',
        order: 'DESC',
      }),
    );
  });
});
