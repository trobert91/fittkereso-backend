import { Injectable } from '@nestjs/common';
import {
  ProductImage,
  ProductImageRepository,
  ProductModel,
  ProductSource,
} from '@fittkereso-backend/database';
import { ProductImageFactory } from './product-image-factory';
import { ProductImageStorageService } from './product-image-storage.service';
import { ProductMetricsService } from '@fittkereso-backend/metrics';
import { CustomLogger } from '@fittkereso-backend/logger';
import { isEmpty, maxBy } from 'lodash';

@Injectable()
export class ProductImageCopyService {
  private readonly logger = new CustomLogger(ProductImageCopyService.name);

  constructor(
    private readonly uploader: ProductImageStorageService,
    private readonly factory: ProductImageFactory,
    private readonly imageRepo: ProductImageRepository,
    private readonly productMetrics: ProductMetricsService,
  ) {}

  async copyImagesFromSource(
    model: ProductModel,
    source: ProductSource,
    urls: string[],
  ): Promise<ProductImage[]> {
    const newUrls = urls.filter(
      (url) => !model.images?.some((img) => img.sourceUrl === url),
    );
    if (isEmpty(newUrls)) {
      return [];
    }

    const maxCurrentOrder =
      maxBy(model.images ?? [], (img) => img.order)?.order ?? -1;

    const images: ProductImage[] = [];

    let order = maxCurrentOrder + 1;
    for (const url of newUrls) {
      try {
        const uploaded = await this.uploader.uploadFromUrl(model.id, url);

        images.push(
          this.factory.create({
            model,
            uploaded,
            source,
            sourceUrl: url,
            order: order++,
          }),
        );
      } catch (error) {
        this.logger.warn(`Failed to copy image ${url}`, {
          productId: model.id,
          error,
        });
        this.productMetrics.productImageCopyFailed(source.type);
      }
    }

    if (images.length > 0) {
      this.productMetrics.productImageCopySuccess(source.type, images.length);
    }

    return this.imageRepo.saveAll(images);
  }
}
