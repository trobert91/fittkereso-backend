import { ConflictException, Injectable } from '@nestjs/common';
import { Seller, SellerRepository, SellerType } from '@fittkereso-backend/database';
import { generateSlug } from '@fittkereso-backend/utils';
import { SellerCreateDto } from '../../models';

@Injectable()
export class SellerCreateService {
  constructor(private readonly sellerRepo: SellerRepository) {}

  public async createSeller(dto: SellerCreateDto): Promise<Seller> {
    const existing = await this.sellerRepo.findOne({
      where: { name: dto.name },
      select: ['id'],
    });
    if (existing) {
      throw new ConflictException(
        `Seller with name "${dto.name}" already exists`,
      );
    }

    const seller = new Seller();
    seller.name = dto.name;
    seller.type = SellerType.business;
    seller.verified = false;
    seller.active = true;

    // Save first to get the id, then compute slug (matches update-service pattern)
    const saved = await this.sellerRepo.save(seller);
    await this.regenerateSlug(saved);

    return this.sellerRepo.save(saved);
  }

  private async regenerateSlug(entity: Seller): Promise<void> {
    let slug = generateSlug(entity.id, entity.name);
    const existing = await this.sellerRepo.findOne({
      where: { slug },
      select: ['id'],
    });
    if (existing && existing.id !== entity.id) {
      slug = slug + '-' + entity.id.slice(-6);
    }
    entity.slug = slug;
  }
}
