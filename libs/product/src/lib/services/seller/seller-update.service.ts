import { Injectable } from '@nestjs/common';
import { Seller, SellerRepository } from '@fittkereso-backend/database';
import { isUndefined } from 'lodash';
import { generateSlug } from '@fittkereso-backend/utils';
import { SellerUpdateDto } from '../../models';

@Injectable()
export class SellerUpdateService {
  constructor(private readonly sellerRepo: SellerRepository) {}

  public async updateSeller(
    id: string,
    dto: SellerUpdateDto,
  ): Promise<Seller> {
    const seller = await this.sellerRepo.findOneOrFail({
      where: { id },
    });

    const nameChanged = dto.name !== seller.name;
    seller.name = dto.name;
    seller.type = dto.type;

    if (!isUndefined(dto.domains)) {
      seller.domains = dto.domains;
    }

    if (!isUndefined(dto.logoUrl)) {
      seller.logoUrl = dto.logoUrl;
    }

    if (!isUndefined(dto.contactEmail)) {
      seller.contactEmail = dto.contactEmail;
    }

    if (!isUndefined(dto.contactPhone)) {
      seller.contactPhone = dto.contactPhone;
    }

    if (!isUndefined(dto.location)) {
      seller.location = dto.location;
    }

    if (!isUndefined(dto.verified)) {
      seller.verified = dto.verified;
    }

    if (!isUndefined(dto.active)) {
      seller.active = dto.active;
    }

    if (!isUndefined(dto.maxConcurrent)) {
      seller.maxConcurrent = dto.maxConcurrent;
    }

    if (!isUndefined(dto.requestsPerHour)) {
      seller.requestsPerHour = dto.requestsPerHour;
    }

    if (nameChanged || !seller.slug) {
      await this.regenerateSlug(seller);
    }

    return this.sellerRepo.save(seller);
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
