import { Injectable } from "@nestjs/common";
import {
  ProductImage,
  ProductImageRepository,
  ProductModel,
  ProductModelRepository,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { orderBy } from "lodash";

@Injectable()
export class ProductImageOrderService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly imageRepo: ProductImageRepository,
  ) {}

  public async updateImageOrderForId(
    id: string,
    imageOrders: { id: string; order: number }[],
  ): Promise<ProductImage[]> {
    const model = await this.productRepo.findOneOrFail({
      where: { id },
      relations: [nameOf<ProductModel>("images")],
    });

    return this.updateImageOrder(model, imageOrders);
  }

  public async updateImageOrder(
    model: ProductModel,
    imageOrders: { id: string; order: number }[],
  ): Promise<ProductImage[]> {
    // reindex orders based on provided order
    const ordered = orderBy(imageOrders, ["order"], ["asc"]);

    let i = 0;
    for (const { id } of ordered) {
      const image = model.images.find((img) => img.id === id);
      if (image) {
        image.order = i++;
      }
    }

    const mainImage = model.images.find((img) => img.order === 0);
    if (mainImage) {
      model.mainImage = mainImage;
    } else {
      model.mainImage = null;
    }

    await this.productRepo.save(model);

    await this.imageRepo.saveAll(model.images);

    return model.images;
  }
}
