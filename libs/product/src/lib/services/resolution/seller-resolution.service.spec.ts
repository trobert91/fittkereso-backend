import { Seller, SellerType } from '@fittkereso-backend/database';
import { SellerResolutionService } from './seller-resolution.service';

describe('SellerResolutionService', () => {
  let mockSellerRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let service: SellerResolutionService;

  beforeEach(() => {
    mockSellerRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
    };
    service = new SellerResolutionService(mockSellerRepo as never);
  });

  it('returns the existing seller when one already matches by exact name', async () => {
    const existing = new Seller();
    existing.id = 'seller-1';
    existing.name = 'Alza.hu';
    mockSellerRepo.findOne.mockResolvedValueOnce(existing);

    const result = await service.resolveOrCreate('Alza.hu');

    expect(result).toBe(existing);
    expect(mockSellerRepo.save).not.toHaveBeenCalled();
  });

  it('creates a new business seller with a generated slug when none exists', async () => {
    mockSellerRepo.findOne.mockResolvedValueOnce(null);
    mockSellerRepo.save.mockImplementation(async (seller: Seller) => {
      if (!seller.id) seller.id = 'seller-new';
      return seller;
    });

    const result = await service.resolveOrCreate('  Alza.hu  ');

    expect(result.name).toBe('Alza.hu');
    expect(result.type).toBe(SellerType.business);
    expect(result.verified).toBe(false);
    expect(result.active).toBe(true);
    expect(result.slug).toBeTruthy();
    expect(mockSellerRepo.save).toHaveBeenCalledTimes(2); // create + slug backfill
  });

  it('recovers from a concurrent-insert race by re-fetching the winning row', async () => {
    mockSellerRepo.findOne.mockResolvedValueOnce(null);
    mockSellerRepo.save.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "UQ_seller_name"'),
    );
    const raceWinner = new Seller();
    raceWinner.id = 'seller-race';
    raceWinner.name = 'Alza.hu';
    mockSellerRepo.findOne.mockResolvedValueOnce(raceWinner);

    const result = await service.resolveOrCreate('Alza.hu');

    expect(result).toBe(raceWinner);
  });

  it('rethrows non-conflict errors', async () => {
    mockSellerRepo.findOne.mockResolvedValueOnce(null);
    mockSellerRepo.save.mockRejectedValueOnce(new Error('connection refused'));

    await expect(service.resolveOrCreate('Alza.hu')).rejects.toThrow(
      'connection refused',
    );
  });
});
