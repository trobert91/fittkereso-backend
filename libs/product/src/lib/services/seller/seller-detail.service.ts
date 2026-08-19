import { Injectable } from '@nestjs/common';
import { Seller, SellerRepository } from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';

@Injectable()
export class SellerDetailService {
  constructor(private readonly sellerRepo: SellerRepository) {}

  public async getById(sellerId: string): Promise<Seller> {
    return this.sellerRepo.findOneOrFail({
      where: { id: sellerId },
      relations: [
        nameOf<Seller>('productSources'),
        nameOf<Seller>('billingInfo'),
      ],
    });
  }
}
