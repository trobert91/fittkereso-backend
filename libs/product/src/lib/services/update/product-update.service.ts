import { Injectable } from '@nestjs/common';
import { ProductModelUpdateDto } from '../../models/product-update.dto';
import {
  AdvisoryLockService,
  BrandRepository,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  productLock,
} from '@fittkereso-backend/database';
import { generateSlug, nameOf } from '@fittkereso-backend/utils';
import { isUndefined } from 'lodash';
import { ProductUpdateMapperService } from './product-update-mapper.service';
import { ProductDescriptionService } from '../product-description/product-description.service';

@Injectable()
export class ProductUpdateService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly brandRepo: BrandRepository,
    private readonly mapper: ProductUpdateMapperService,
    private readonly locks: AdvisoryLockService,
    private readonly descriptionService: ProductDescriptionService,
  ) {}

  public async updateProduct(
    id: string,
    dto: ProductModelUpdateDto,
  ): Promise<ProductModel> {
    // Under the product's lock, so an import writing to it meanwhile is not
    // overwritten with a copy loaded before.
    return this.locks.withLocks([productLock(id)], async () => {
      const product = await this.getProductById(id);
      await this.mapper.mapDtoToEntity(dto, product);
      // Only the description: the full mergeSources would also recompute the
      // name fields from the sources, undoing a name edit in this same save.
      if (!isUndefined(dto.description)) {
        product.description = this.descriptionService.pick(product.sources);
      }

      await this.generateSlug(product);

      return this.productRepo.save(product);
    });
  }

  private async generateSlug(entity: ProductModel): Promise<void> {
    const brandName =
      entity.brand?.name ??
      (await this.brandRepo.findByIdOrFail(entity.brand?.id)).name;
    let slug = generateSlug(
      entity.id,
      brandName,
      entity.model || entity.displayName,
    );
    const existing = await this.productRepo.findOne({
      where: { slug },
      select: ['id'],
    });
    if (existing && existing.id !== entity.id) {
      slug = slug + '-' + entity.id.slice(-6);
    }
    entity.slug = slug;
  }

  private async getProductById(id: string): Promise<ProductModel> {
    return this.productRepo.findOneOrFail({
      where: { id },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('aliases'),
        nameOf<ProductModel>('embedding'),
        // The admin's record takes the edits the admin makes to specs and the
        // description; without its records loaded, each edit added another.
        nameOf<ProductModel>('sources'),
        `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}`,
      ],
    });
  }
}
