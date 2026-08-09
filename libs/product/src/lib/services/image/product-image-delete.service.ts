import { Injectable } from "@nestjs/common";
import {
  ProductImageRepository,
  ProductModel,
  ProductModelRepository,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { ProductImageOrderService } from "./product-image-order.service";
import { ProductImageStorageService } from "./product-image-storage.service";

@Injectable()
export class ProductImageDeleteService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly imageRepo: ProductImageRepository,
    private readonly orderService: ProductImageOrderService,
    private readonly imageStorageService: ProductImageStorageService,
  ) {}

  public async deleteImage(productId: string, imageId: string): Promise<void> {
    const model = await this.productRepo.findOneOrFail({
      where: { id: productId },
      relations: [nameOf<ProductModel>("images")],
    });
    const image = model.images.find((img) => img.id === imageId);
    if (!image) {
      throw new Error(`Image not found: ${imageId}`);
    }

    await this.imageRepo.deleteById(image.id);
    model.images = model.images.filter((img) => img.id !== imageId);

    await this.imageStorageService.deleteFile(productId, image.fileName);

    await this.orderService.updateImageOrder(
      model,
      model.images.map((img) => ({ id: img.id, order: img.order })),
    );
  }
}
