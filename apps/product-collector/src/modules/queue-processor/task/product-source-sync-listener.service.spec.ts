import { ProductSourceSyncListener } from './product-source-sync-listener.service';

describe('ProductSourceSyncListener', () => {
  const source = {
    id: 'source-1',
    name: 'speedbike-arukereso',
    type: 'arukereso',
    config: { categories: { ebikes: { enabled: true }, bikes: { enabled: false } } },
  };
  let importer: { import: jest.Mock };
  let categories: { id: string; slug: string }[];
  let listener: ProductSourceSyncListener;

  beforeEach(() => {
    importer = { import: jest.fn().mockResolvedValue({}) };
    categories = [
      { id: 'category-ebikes', slug: 'ebikes' },
      { id: 'category-bikes', slug: 'bikes' },
    ];
    listener = new ProductSourceSyncListener(
      { findOneOrFail: jest.fn().mockResolvedValue(source), save: jest.fn() } as never,
      {
        repo: {
          findBy: jest.fn(async ({ id }: { id: { _value: string[] } }) =>
            categories.filter((category) => id._value.includes(category.id)),
          ),
        },
      } as never,
      { get: jest.fn().mockReturnValue(importer) } as never,
      { problems: jest.fn().mockReturnValue(null) } as never,
      { recordAction: jest.fn() } as never,
    );
  });

  it('runs every enabled category when none is asked for', async () => {
    await listener.process({ productSourceId: 'source-1' });

    expect(importer.import).toHaveBeenCalledWith(source, { categorySlugs: ['ebikes'] });
  });

  it('narrows the run to the enabled categories asked for', async () => {
    await listener.process({ productSourceId: 'source-1', categoryIds: ['category-ebikes'] });

    expect(importer.import).toHaveBeenCalledWith(source, { categorySlugs: ['ebikes'] });
  });

  // An empty list reads as every enabled category to the importer: a full
  // run, delisting sweep included, nobody asked for.
  it.each([
    ['only disabled categories', ['category-bikes']],
    ['categories that do not exist', ['category-gone']],
  ])('runs nothing when asked for %s', async (_label, categoryIds) => {
    await listener.process({ productSourceId: 'source-1', categoryIds });

    expect(importer.import).not.toHaveBeenCalled();
  });
});
