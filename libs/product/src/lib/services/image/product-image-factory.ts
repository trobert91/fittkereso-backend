import { Injectable } from "@nestjs/common";
import {
  ProductModel,
  ProductSource,
  ProductImage,
} from "@ebike-backend/database";
import { UploadedFile } from "@ebike-backend/storage";

@Injectable()
export class ProductImageFactory {
  create({
    model,
    uploaded,
    source,
    sourceUrl,
    order,
  }: {
    model: ProductModel;
    uploaded: UploadedFile;
    source?: ProductSource;
    sourceUrl?: string;
    order: number;
  }): ProductImage {
    const image = new ProductImage();
    image.model = model;
    image.url = uploaded.url;
    image.fileName = uploaded.fileName;

    image.source = source;
    image.sourceUrl = sourceUrl;
    image.order = order;

    return image;
  }
}
