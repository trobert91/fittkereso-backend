import { ConflictException, Injectable } from '@nestjs/common';
import { Brand, BrandRepository } from '@fittkereso-backend/database';
import { generateSlug } from '@fittkereso-backend/utils';
import { BrandCreateDto } from '../../models';

@Injectable()
export class BrandCreateService {
  constructor(private readonly brandRepo: BrandRepository) {}

  public async createBrand(dto: BrandCreateDto): Promise<Brand> {
    const existing = await this.brandRepo.findOne({
      where: { name: dto.name },
      select: ['id'],
    });
    if (existing) {
      throw new ConflictException(
        `Brand with name "${dto.name}" already exists`,
      );
    }

    const brand = new Brand();
    brand.name = dto.name;
    brand.domains = dto.domains;

    // Save first to get the id, then compute slug (matches update-service pattern)
    const saved = await this.brandRepo.save(brand);
    await this.regenerateSlug(saved);

    return this.brandRepo.save(saved);
  }

  private async regenerateSlug(entity: Brand): Promise<void> {
    let slug = generateSlug(entity.id, entity.name);
    const existing = await this.brandRepo.findOne({
      where: { slug },
      select: ['id'],
    });
    if (existing && existing.id !== entity.id) {
      slug = slug + '-' + entity.id.slice(-6);
    }
    entity.slug = slug;
  }
}
