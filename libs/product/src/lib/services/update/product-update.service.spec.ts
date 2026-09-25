import { ProductModel } from '@fittkereso-backend/database';
import { ProductUpdateService } from './product-update.service';
import { ProductUpdateMapperService } from './product-update-mapper.service';
import { ProductDescriptionService } from '../product-description/product-description.service';

describe('ProductUpdateService', () => {
  let service: ProductUpdateService;
  let productRepo: { findOneOrFail: jest.Mock; findOne: jest.Mock; save: jest.Mock };
  let locks: { withLocks: jest.Mock };
  let product: ProductModel;

  const sourceText = 'A bolt leírása a kerékpárról, elég hosszan ahhoz, hogy számítson.';

  beforeEach(() => {
    product = {
      id: 'product-1',
      displayName: 'KTM Macina Team',
      model: 'Macina Team',
      brand: { id: 'brand-ktm', name: 'KTM' },
      description: sourceText,
      sources: [
        {
          id: 'record-arukereso',
          source: { id: 'arukereso', priority: 60 },
          scrapedProduct: { description: `<p>${sourceText}</p>` },
        },
      ],
    } as unknown as ProductModel;
    productRepo = {
      findOneOrFail: jest.fn().mockImplementation(async () => product),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation(async (saved) => saved),
    };
    locks = { withLocks: jest.fn(async (_keys: unknown, work: () => Promise<unknown>) => work()) };
    service = new ProductUpdateService(
      productRepo as never,
      {} as never, // brandRepo
      new ProductUpdateMapperService(
        {} as never, // categoryRepo
        {} as never, // brandRepo
        {} as never, // productImageRepo
        { createProductEmbedding: jest.fn().mockResolvedValue([0.1]) } as never,
        { normalizeProduct: jest.fn().mockReturnValue('ktm macina team 2023') } as never,
        { getConfig: jest.fn().mockReturnValue(undefined) } as never,
      ),
      locks as never,
      new ProductDescriptionService(),
    );
  });

  it("loads the product's records, so the admin's record is found, not added again", async () => {
    await service.updateProduct('product-1', { enabled: true });

    const { relations } = productRepo.findOneOrFail.mock.calls[0][0];
    expect(relations).toEqual(expect.arrayContaining(['sources', 'sources.source']));
  });

  it("makes the admin's description the product's, and survives on the admin record", async () => {
    const saved = await service.updateProduct('product-1', { description: 'Az admin szövege.' });

    expect(saved.description).toBe('Az admin szövege.');
    expect(saved.sources.find((record) => !record.source)?.scrapedProduct?.description).toBe(
      'Az admin szövege.',
    );
  });

  it("falls back to the sources' description when the override is cleared", async () => {
    await service.updateProduct('product-1', { description: 'Az admin szövege.' });
    const saved = await service.updateProduct('product-1', { description: '' });

    expect(saved.description).toBe(sourceText);
  });

  // mergeSources would recompute the names from the sources too.
  it('leaves a name edit in the same save alone', async () => {
    const saved = await service.updateProduct('product-1', {
      displayName: 'KTM Macina Team 2023',
      description: 'Az admin szövege.',
    });

    expect(saved.displayName).toBe('KTM Macina Team 2023');
  });

  it('leaves the description alone when the edit does not touch it', async () => {
    product.description = 'kézzel írt, régi';

    const saved = await service.updateProduct('product-1', { enabled: false });

    expect(saved.description).toBe('kézzel írt, régi');
  });
});
