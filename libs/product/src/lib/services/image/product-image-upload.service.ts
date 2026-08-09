import { Injectable } from "@nestjs/common";
import {
  ProductImage,
  ProductImageRepository,
  ProductModel,
  ProductModelRepository,
} from "@ebike-backend/database";
import * as fs from "fs";
import { ProductImageFactory } from "./product-image-factory";
import { ProductImageStorageService } from "./product-image-storage.service";
import { nameOf } from "@ebike-backend/utils";
import { maxBy } from "lodash";

@Injectable()
export class ProductImageUploadService {
  constructor(
    private readonly uploader: ProductImageStorageService,
    private readonly factory: ProductImageFactory,
    private readonly productRepo: ProductModelRepository,
    private readonly imageRepo: ProductImageRepository,
  ) {}

  async uploadImage(
    productId: string,
    originalName: string,
    file: Buffer | fs.ReadStream | string,
  ): Promise<ProductImage> {
    const model = await this.productRepo.findOneOrFail({
      where: { id: productId },
      relations: [nameOf<ProductModel>("images")],
    });
    const maxCurrentOrder =
      maxBy(model.images ?? [], (img) => img.order)?.order ?? -1;

    const uploaded = await this.uploader.uploadLocal(
      model.id,
      originalName,
      file,
    );
    const image = this.factory.create({
      model,
      uploaded,
      order: maxCurrentOrder + 1,
    });

    return this.imageRepo.save(image);
  }
}
