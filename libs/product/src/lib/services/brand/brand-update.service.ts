import { Injectable } from "@nestjs/common";
import { Brand, BrandRepository } from "@ebike-backend/database";
import { isUndefined } from "lodash";
import { generateSlug, nameOf } from "@ebike-backend/utils";
import { BrandUpdateDto } from "../../models";

@Injectable()
export class BrandUpdateService {
  constructor(private readonly brandRepo: BrandRepository) {}

  public async updateBrand(id: string, dto: BrandUpdateDto): Promise<Brand> {
    const brand = await this.brandRepo.findOneOrFail({
      where: { id },
      relations: [nameOf<Brand>("aliases")],
    });

    if (!isUndefined(dto.name)) {
      brand.name = dto.name;
    }

    if (!isUndefined(dto.domains)) {
      brand.domains = dto.domains;
    }

    await this.regenerateSlug(brand);

    return this.brandRepo.save(brand);
  }

  private async regenerateSlug(entity: Brand): Promise<void> {
    let slug = generateSlug(entity.id, entity.name);
    const existing = await this.brandRepo.findOne({
      where: { slug },
      select: ["id"],
    });
    if (existing && existing.id !== entity.id) {
      slug = slug + "-" + entity.id.slice(-6);
    }
    entity.slug = slug;
  }
}
