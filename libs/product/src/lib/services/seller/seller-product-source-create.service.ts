import { ConflictException, Injectable } from '@nestjs/common';
import {
  ProductSource,
  ProductSourceRepository,
  SellerRepository,
} from '@fittkereso-backend/database';
import { SellerProductSourceCreateDto } from '../../models';

@Injectable()
export class SellerProductSourceCreateService {
  constructor(
    private readonly sellerRepo: SellerRepository,
    private readonly productSourceRepo: ProductSourceRepository,
  ) {}

  public async createForSeller(
    sellerId: string,
    dto: SellerProductSourceCreateDto,
  ): Promise<ProductSource> {
    const seller = await this.sellerRepo.findOneOrFail({
      where: { id: sellerId },
    });

    const existing = await this.productSourceRepo.findOne({
      where: { name: dto.name },
      select: ['id'],
    });
    if (existing) {
      throw new ConflictException(
        `Product source with name "${dto.name}" already exists`,
      );
    }

    const source = new ProductSource();
    source.name = dto.name;
    source.seller = seller;
    source.schedulingEnabled = false;
    source.processingEnabled = false;

    return this.productSourceRepo.save(source);
  }
}
