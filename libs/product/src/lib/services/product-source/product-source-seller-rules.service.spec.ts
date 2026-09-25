import { BadRequestException } from '@nestjs/common';
import { ProductSource, ProductSourceRepository } from '@fittkereso-backend/database';
import { QueryFailedError } from 'typeorm';
import { ProductSourceSellerRulesService } from './product-source-seller-rules.service';

const source = (id: string, priority: number, identifiesProducts = true): ProductSource =>
  ({ id, name: `source-${id}`, priority, identifiesProducts }) as ProductSource;

describe('ProductSourceSellerRulesService', () => {
  let repo: jest.Mocked<Pick<ProductSourceRepository, 'find' | 'findOne'>>;
  let service: ProductSourceSellerRulesService;

  beforeEach(() => {
    repo = { find: jest.fn(), findOne: jest.fn() };
    service = new ProductSourceSellerRulesService(repo as unknown as ProductSourceRepository);
  });

  describe('defaultPriority', () => {
    it('gives a seller its first source 10', async () => {
      repo.find.mockResolvedValue([]);
      await expect(service.defaultPriority('seller-1')).resolves.toBe(10);
    });

    it('puts a later source 10 below the seller\'s lowest', async () => {
      repo.find.mockResolvedValue([source('a', 60), source('b', 40)]);
      await expect(service.defaultPriority('seller-1')).resolves.toBe(30);
    });

    it('counts up from 0 to the first free value when 10 below would be negative', async () => {
      repo.find.mockResolvedValue([source('a', 1), source('b', 0), source('c', 5)]);
      await expect(service.defaultPriority('seller-1')).resolves.toBe(2);
    });
  });

  describe('assertPriorityFree', () => {
    it('refuses a priority another source of the seller holds, naming it', async () => {
      repo.findOne.mockResolvedValue(source('other', 60));
      await expect(
        service.assertPriorityFree({ sellerId: 'seller-1', priority: 60, excludingSourceId: 'mine' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.assertPriorityFree({ sellerId: 'seller-1', priority: 60 }),
      ).rejects.toThrow(/Priority 60 is already used by "source-other"/);
    });

    it('allows the source to keep its own priority', async () => {
      repo.findOne.mockResolvedValue(source('mine', 60));
      await expect(
        service.assertPriorityFree({ sellerId: 'seller-1', priority: 60, excludingSourceId: 'mine' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertKeepsIdentifyingSource', () => {
    it('requires a seller\'s first source to identify products', async () => {
      repo.find.mockResolvedValue([]);
      await expect(
        service.assertKeepsIdentifyingSource({ next: { sellerId: 'seller-1', identifiesProducts: false } }),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows a contributing source next to an identifying one', async () => {
      repo.find.mockResolvedValue([source('arukereso', 60)]);
      await expect(
        service.assertKeepsIdentifyingSource({ next: { sellerId: 'seller-1', identifiesProducts: false } }),
      ).resolves.toBeUndefined();
    });

    it('refuses to turn off the seller\'s last identifying source', async () => {
      repo.find.mockResolvedValue([source('arukereso', 60), source('google', 40, false)]);
      await expect(
        service.assertKeepsIdentifyingSource({
          next: { id: 'arukereso', sellerId: 'seller-1', identifiesProducts: false },
        }),
      ).rejects.toThrow(/at least one source that identifies products/);
    });

    it('refuses to move a seller\'s only identifying source away from its contributors', async () => {
      repo.find.mockImplementation(async (options) => {
        const sellerId = (options?.where as { seller: { id: string } }).seller.id;
        return sellerId === 'old-seller'
          ? [source('arukereso', 60), source('google', 40, false)]
          : [];
      });
      await expect(
        service.assertKeepsIdentifyingSource({
          next: { id: 'arukereso', sellerId: 'new-seller', identifiesProducts: true },
          previousSellerId: 'old-seller',
        }),
      ).rejects.toThrow(/Moving this source/);
    });

    it('allows a seller to be left with no sources at all', async () => {
      repo.find.mockImplementation(async (options) => {
        const sellerId = (options?.where as { seller: { id: string } }).seller.id;
        return sellerId === 'old-seller' ? [source('only', 10)] : [];
      });
      await expect(
        service.assertKeepsIdentifyingSource({
          next: { id: 'only', sellerId: 'new-seller', identifiesProducts: true },
          previousSellerId: 'old-seller',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertCompletenessAllowed', () => {
    it('refuses hasAllProducts on a scraping source', () => {
      expect(() =>
        service.assertCompletenessAllowed({ type: 'scraping', hasAllProducts: true }),
      ).toThrow(BadRequestException);
    });

    it('allows it on a feed source, and anything with the flag off', () => {
      expect(() =>
        service.assertCompletenessAllowed({ type: 'arukereso', hasAllProducts: true }),
      ).not.toThrow();
      expect(() =>
        service.assertCompletenessAllowed({ type: 'scraping', hasAllProducts: false }),
      ).not.toThrow();
    });
  });

  describe('translateSaveError', () => {
    const violation = (detail: string): QueryFailedError =>
      new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key value'), { detail }));

    it('reports a lost race for the priority as the priority error', () => {
      const translated = service.translateSaveError(
        violation('Key ("sellerId", priority)=(s, 60) already exists.'),
        60,
      );
      expect(translated).toBeInstanceOf(BadRequestException);
      expect((translated as BadRequestException).message).toMatch(/Priority 60/);
    });

    it('returns any other error unchanged', () => {
      const other = violation('Key (name)=(x) already exists.');
      expect(service.translateSaveError(other, 60)).toBe(other);
    });
  });
});
