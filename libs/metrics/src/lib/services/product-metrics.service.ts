import { Injectable } from '@nestjs/common';
import * as client from 'prom-client';
import { PrometheusService } from '../prometheus.service';
import {
  NEW_PRODUCT_CREATED,
  PRODUCT_ALIAS_CREATED_TOTAL,
  PRODUCT_BRAND_RESOLUTION_FAILED_TOTAL,
  PRODUCT_IMAGE_COPY_TOTAL,
  PRODUCT_IMAGE_CREATED,
  PRODUCT_MATCHED_TOTAL,
  PRODUCT_SOURCE_SPEC_VALIDATION_FAILED_TOTAL,
  PRODUCT_SPEC_VALIDATION_FAILED,
  PRODUCT_UPDATED,
  SCRAPE_RESOLUTION_OUTCOME_TOTAL,
} from '../metric-names';

export type ScrapeResolutionOutcome =
  | 'skipped_no_category'
  | 'path1_hit'
  | 'cross_source_merge'
  | 'cross_source_rejected_same_source'
  | 'new_product';
import { ProductSourceType } from '@fittkereso-backend/database';

@Injectable()
export class ProductMetricsService {
  private readonly newProductCounter: client.Counter<string>;
  private readonly productUpdatedCounter: client.Counter<string>;
  private readonly productImageCreatedCounter: client.Counter<string>;
  private readonly productSpecValidationFailedCounter: client.Counter<string>;
  private readonly productMatchedCounter: client.Counter<string>;
  private readonly productAliasCreatedCounter: client.Counter<string>;
  private readonly productBrandResolutionFailedCounter: client.Counter<string>;
  private readonly productSourceSpecValidationFailedCounter: client.Counter<string>;
  private readonly productImageCopyCounter: client.Counter<string>;
  private readonly scrapeResolutionOutcomeCounter: client.Counter<string>;

  constructor(private readonly prometheusService: PrometheusService) {
    this.newProductCounter = new client.Counter({
      name: NEW_PRODUCT_CREATED,
      help: 'Total number of new products created',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productUpdatedCounter = new client.Counter({
      name: PRODUCT_UPDATED,
      help: 'Total number of products updated',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productImageCreatedCounter = new client.Counter({
      name: PRODUCT_IMAGE_CREATED,
      help: 'Total number of product images created',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productSpecValidationFailedCounter = new client.Counter({
      name: PRODUCT_SPEC_VALIDATION_FAILED,
      help: 'Total number of product spec validation failures',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productMatchedCounter = new client.Counter({
      name: PRODUCT_MATCHED_TOTAL,
      help: 'Total existing products matched during scraping',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productAliasCreatedCounter = new client.Counter({
      name: PRODUCT_ALIAS_CREATED_TOTAL,
      help: 'Total new product aliases created from scraping',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productBrandResolutionFailedCounter = new client.Counter({
      name: PRODUCT_BRAND_RESOLUTION_FAILED_TOTAL,
      help: 'Total brand identification failures during scraping',
      labelNames: ['source'],
      registers: [this.prometheusService.register],
    });
    this.productSourceSpecValidationFailedCounter = new client.Counter({
      name: PRODUCT_SOURCE_SPEC_VALIDATION_FAILED_TOTAL,
      help: 'Total per-source spec validation failures',
      labelNames: ['source', 'category'],
      registers: [this.prometheusService.register],
    });
    this.productImageCopyCounter = new client.Counter({
      name: PRODUCT_IMAGE_COPY_TOTAL,
      help: 'Total image copy operations by outcome',
      labelNames: ['source', 'status'],
      registers: [this.prometheusService.register],
    });
    this.scrapeResolutionOutcomeCounter = new client.Counter({
      name: SCRAPE_RESOLUTION_OUTCOME_TOTAL,
      help: 'Total scrape resolution outcomes by result and source',
      labelNames: ['source', 'result'],
      registers: [this.prometheusService.register],
    });
  }

  newProductCreated(source: ProductSourceType): void {
    this.newProductCounter.inc({ source });
  }

  productUpdated(source: ProductSourceType): void {
    this.productUpdatedCounter.inc({ source });
  }

  productImagesCreated(
    source: ProductSourceType,
    numberOfImages: number,
  ): void {
    this.productImageCreatedCounter.inc({ source }, numberOfImages);
  }

  productSpecValidationFailed(source: ProductSourceType): void {
    this.productSpecValidationFailedCounter.inc({ source });
  }

  productMatched(source: ProductSourceType): void {
    this.productMatchedCounter.inc({ source });
  }

  productAliasCreated(source: ProductSourceType, count: number): void {
    this.productAliasCreatedCounter.inc({ source }, count);
  }

  productBrandResolutionFailed(source: ProductSourceType): void {
    this.productBrandResolutionFailedCounter.inc({ source });
  }

  productSourceSpecValidationFailed(
    source: ProductSourceType,
    category: string,
  ): void {
    this.productSourceSpecValidationFailedCounter.inc({ source, category });
  }

  productImageCopySuccess(source: ProductSourceType, count: number): void {
    this.productImageCopyCounter.inc({ source, status: 'success' }, count);
  }

  productImageCopyFailed(source: ProductSourceType): void {
    this.productImageCopyCounter.inc({ source, status: 'failed' });
  }

  scrapeResolutionOutcome(
    source: ProductSourceType,
    result: ScrapeResolutionOutcome,
  ): void {
    this.scrapeResolutionOutcomeCounter.inc({ source, result });
  }
}
