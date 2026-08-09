import { Injectable } from "@nestjs/common";
import { ProductImage, ProductModel } from "@ebike-backend/database";
import { FileStorageService } from "@ebike-backend/storage";

@Injectable()
export class ProductImageDtoService {
  constructor(private readonly fileStorageService: FileStorageService) {}

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
