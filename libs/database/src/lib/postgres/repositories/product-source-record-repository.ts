import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductSourceRecord } from '../models/product-source-record.entity';
import { isEmpty } from 'lodash';
import { nameOf } from '@fittkereso-backend/utils';

@Injectable()
export class ProductSourceRecordRepository extends BasePostgresRepository<ProductSourceRecord> {
  constructor(
    @InjectRepository(ProductSourceRecord, 'postgres')
    repository: Repository<ProductSourceRecord>,
  ) {
    super(repository, ProductSourceRecord);
  }

  async findByUrl(url: string): Promise<ProductSourceRecord | null> {
    return this.repo.findOne({
      where: { url },
      relations: [nameOf<ProductSourceRecord>('model'), nameOf<ProductSourceRecord>('offers')],
    });
  }

  /**
   * Cheap identity lookup by (source, externalId) — the source-native SKU/
   * model code/slug, stable across URL changes. Used ahead of full identity
   * resolution to recognize an already-known listing so extraction/LLM
   * unification can be skipped when its offerSpecsHash/productSpecsHash is
   * unchanged.
   *
   * Loads `offers` too — offer-level specs (e.g. frameSize/color) are
   * deliberately stripped out of ProductSourceRecord.scrapedProduct.specs
   * (they vary per offer, not per record), so the offerSpecsHash-unchanged
   * fast path in ProductDetailsPageScraperService.extractProduct must read
   * them back off the previously-persisted Offer row instead.
   */
  async findBySourceAndExternalId(
    sourceId: string,
    externalId: string,
  ): Promise<ProductSourceRecord | null> {
    return this.repo.findOne({
      where: {
        source: { id: sourceId },
        externalId,
      },
      relations: [nameOf<ProductSourceRecord>('model'), nameOf<ProductSourceRecord>('offers')],
    });
  }

  /**
   * Same (source, externalId) identity lookup as findBySourceAndExternalId,
   * but with `model` loaded via the given relations so the result can be used
   * directly as a resolved ProductModel (see ProductScrapeUpdaterService
   * Path 0.5) instead of only as a cheap existence check.
   */
  async findBySourceAndExternalIdWithModelRelations(
    sourceId: string,
    externalId: string,
    modelRelations: string[],
  ): Promise<ProductSourceRecord | null> {
    return this.repo.findOne({
      where: {
        source: { id: sourceId },
        externalId,
      },
      relations: [
        nameOf<ProductSourceRecord>('model'),
        ...modelRelations.map(
          (relation) => `${nameOf<ProductSourceRecord>('model')}.${relation}`,
        ),
      ],
    });
  }

  /**
   * Finds any other ProductSourceRecord from the same source whose
   * productSpecsHash matches — used to reuse an already-unified product-
   * identity specs contribution for a brand-new listing (e.g. a not-yet-seen
   * size/color variant) without a second model-spec LLM call. Picks the most
   * recently updated match. No `relations` needed — only
   * `scrapedProduct.specs` (a plain jsonb column) is read from the result.
   */
  async findBySourceAndProductSpecsHash(
    sourceId: string,
    productSpecsHash: string,
  ): Promise<ProductSourceRecord | null> {
    return this.repo.findOne({
      where: {
        source: { id: sourceId },
        productSpecsHash,
      },
      order: { lastUpdated: 'DESC' },
    });
  }

  async findExistingUrls(urls: string[]): Promise<Set<string>> {
    if (isEmpty(urls)) return new Set();

    const results = await this.repo
      .createQueryBuilder('source')
      .select(`source.${nameOf<ProductSourceRecord>('url')}`)
      .where(`source.${nameOf<ProductSourceRecord>('url')} IN (:...urls)`, {
        urls,
      })
      .getMany();

    return new Set(results.map((source) => source.url!));
  }
}
