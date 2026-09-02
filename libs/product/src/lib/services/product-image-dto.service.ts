import { Injectable } from '@nestjs/common';
import {
  ProductImage,
  ProductModel,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { FileStorageService } from '@fittkereso-backend/storage';
import { compact, isEmpty } from 'lodash';

@Injectable()
export class ProductImageDtoService {
  constructor(
    private readonly fileStorageService: FileStorageService,
    private readonly productRepo: ProductModelRepository,
  ) {}

  /**
   * Thumbnail URLs for a set of product ids, as `productId => imageUrl`.
   *
   * For places that hold ids rather than loaded products — the resolution
   * queue's candidates, which persist a `candidateId` and nothing else, being
   * the case this exists for. One query for the whole set, so a page of rows
   * costs one round trip rather than one per candidate.
   *
   * Ids with no product, or a product with no main image, are simply absent from
   * the map rather than present with `undefined`. That makes a missing entry
   * mean one thing — "no picture to show" — whether the product was deleted by a
   * merge or never had an image, which is all the caller can act on anyway.
   *
   * Built here rather than denormalized into the stored candidate because the
   * URL is not stored anywhere: it is `{cdnUrl}/products/{id}/{fileName}`,
   * assembled per request from config. A copy frozen into a jsonb column would
   * outlive the CDN it names and go stale the moment the product's image is
   * replaced.
   */
  public async getMainImageUrls(
    productIds: string[],
  ): Promise<Record<string, string>> {
    const ids = compact(productIds);
    if (isEmpty(ids)) return {};

    const products = await this.productRepo.findMainImages([...new Set(ids)]);

    return products.reduce<Record<string, string>>((map, product) => {
      const fileName = product.mainImage?.fileName;
      if (fileName) {
        map[product.id] = this.fileStorageService.getFileUrl(
          `products/${product.id}`,
          fileName,
        );
      }
      return map;
    }, {});
  }

  public updateProductImageUrls(products: ProductModel[] | undefined): void {
    products
      ?.filter((p) => p !== undefined && p !== null)
      .forEach((product) => {
        this.updateImageUrls(product.id, product.images);
        if (product.mainImage) {
          this.updateImageUrls(product.id, [product.mainImage]);
        }
      });
  }

  public updateImageUrls(
    productModelId: string,
    images: ProductImage[] | undefined,
  ): void {
    images?.forEach((image) => {
      image.url = this.fileStorageService.getFileUrl(
        `products/${productModelId}`,
        image.fileName,
      );
    });
  }
}
