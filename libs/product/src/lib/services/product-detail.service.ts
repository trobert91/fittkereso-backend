import { Injectable } from '@nestjs/common';
import {
  Offer,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductImportTask,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { nameOf } from '@fittkereso-backend/utils';
import { ProductImageDtoService } from './product-image-dto.service';

@Injectable()
export class ProductDetailService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly imageDtoService: ProductImageDtoService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  public async getProductById(productId: string): Promise<ProductModel> {
    const product = await this.productRepo.findOneOrFail({
      where: { id: productId },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('aliases'),
        nameOf<ProductModel>('images'),
        nameOf<ProductModel>('mainImage'),
        nameOf<ProductModel>('sources'),
        `sources.${nameOf<ProductSourceRecord>('source')}`,
        `sources.${nameOf<ProductSourceRecord>('offers')}`,
        `sources.${nameOf<ProductSourceRecord>('offers')}.${nameOf<Offer>('seller')}`,
        nameOf<ProductModel>('offers'),
        `${nameOf<ProductModel>('offers')}.${nameOf<Offer>('seller')}`,
        nameOf<ProductModel>('importTasks'),
        `importTasks.${nameOf<ProductImportTask>('source')}`,
      ],
      order: {
        importTasks: { createdAt: 'DESC' },
        // NULLS LAST because lastSynced is nullable: Postgres sorts NULLs
        // first on DESC, which would float never-synced offers above every
        // freshly confirmed one.
        offers: { lastSynced: { direction: 'DESC', nulls: 'LAST' } },
      },
    });

    this.imageDtoService.updateProductImageUrls([product]);
    this.attachCategorySchemas(product);

    return product;
  }

  private attachCategorySchemas(product: ProductModel): void {
    const slug = product.productCategory?.slug;
    if (!slug) {
      return;
    }

    product.productCategory!.jsonSchema =
      this.categoryConfigService.getJsonSchema(slug);
    product.productCategory!.uiSchema =
      this.categoryConfigService.getUiSchema(slug);
  }
}
