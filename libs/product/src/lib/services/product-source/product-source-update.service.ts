import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ProductSource,
  ProductSourceRepository,
  SellerRepository,
} from '@fittkereso-backend/database';
import ms from 'ms';
import { ProductSourceUpdateParams } from '../../models/product-source-update-params';

@Injectable()
export class ProductSourceUpdateService {
  constructor(
    private readonly productSourceRepo: ProductSourceRepository,
    private readonly sellerRepo: SellerRepository,
  ) {}

  public async updateProductSource(
    productSourceId: string,
    params: ProductSourceUpdateParams,
  ): Promise<ProductSource> {
    // The seller relation is loaded so the saved entity we return still carries
    // it — the admin details route serializes it.
    const source = await this.productSourceRepo.findOne({
      where: { id: productSourceId },
      relations: { seller: true },
    });

    if (!source) {
      throw new NotFoundException('Product source not found');
    }

    if (params.name !== undefined) {
      source.name = params.name.trim();
    }

    if (params.sellerId !== undefined) {
      const seller = await this.sellerRepo.findById(params.sellerId);
      if (!seller) {
        throw new NotFoundException('Seller not found');
      }

      source.seller = seller;
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

    if (params.nextFullSyncAt !== undefined) {
      source.nextFullSyncAt = this.parseDate(
        params.nextFullSyncAt,
        'nextFullSyncAt',
      );
    }

    if (params.nextIncrementalSyncAt !== undefined) {
      source.nextIncrementalSyncAt = this.parseDate(
        params.nextIncrementalSyncAt,
        'nextIncrementalSyncAt',
      );
    }

    await this.productSourceRepo.save(source);

    return source;
  }

  // Clearing has to resolve to null, not undefined: TypeORM's save() skips
  // undefined properties, so an undefined here would leave the old value in
  // the column instead of wiping it.
  private parseInterval(
    value: string | null,
    fieldName: string,
  ): ms.StringValue | null {
    if (value === null || value.trim() === '') {
      return null;
    }

    const parsedInterval = ms(value as ms.StringValue);
    if (parsedInterval === undefined) {
      throw new BadRequestException(`Invalid ${fieldName} format`);
    }

    return value as ms.StringValue;
  }

  // Clearing a next-sync timestamp is meaningful — ProductSourceSyncScheduler
  // reads a NULL as "due on the next tick" — so an empty value maps to null.
  private parseDate(value: string | null, fieldName: string): Date | null {
    if (value === null || value.trim() === '') {
      return null;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid ${fieldName} format`);
    }

    return parsed;
  }
}
