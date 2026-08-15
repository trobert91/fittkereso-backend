import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ProductSource, ProductSourceRepository } from '@fittkereso-backend/database';
import ms from 'ms';
import { ProductSourceUpdateParams } from '../../models/product-source-update-params';

@Injectable()
export class ProductSourceUpdateService {
  constructor(private readonly productSourceRepo: ProductSourceRepository) {}

  public async updateProductSource(
    productSourceId: string,
    params: ProductSourceUpdateParams,
  ): Promise<ProductSource> {
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
    });

    if (!source) {
      throw new NotFoundException('Product source not found');
    }

    if (params.name !== undefined) {
      source.name = params.name.trim();
    }

    if (params.config !== undefined) {
      source.config = params.config;
    }

    if (params.schedulingEnabled !== undefined) {
      source.schedulingEnabled = params.schedulingEnabled;
    }

    if (params.processingEnabled !== undefined) {
      source.processingEnabled = params.processingEnabled;
    }

    if (params.priority !== undefined) {
      source.priority = params.priority;
    }

    if (params.maxConcurrent !== undefined) {
      source.maxConcurrent = params.maxConcurrent;
    }

    if (params.requestsPerHour !== undefined) {
      source.requestsPerHour = params.requestsPerHour;
    }

    if (params.fullSyncInterval !== undefined) {
      source.fullSyncInterval = this.parseInterval(
        params.fullSyncInterval,
        'fullSyncInterval',
      );
    }

    if (params.incrementalSyncInterval !== undefined) {
      source.incrementalSyncInterval = this.parseInterval(
        params.incrementalSyncInterval,
        'incrementalSyncInterval',
      );
    }

    await this.productSourceRepo.save(source);

    return source;
  }

  private parseInterval(
    value: string | null,
    fieldName: string,
  ): ms.StringValue | undefined {
    if (value === null || value.trim() === '') {
      return undefined;
    }

    const parsedInterval = ms(value as ms.StringValue);
    if (parsedInterval === undefined) {
      throw new BadRequestException(`Invalid ${fieldName} format`);
    }

    return value as ms.StringValue;
  }
}
