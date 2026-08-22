import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductSourceRecord } from '../models/product-source-record.entity';
import { ProductModel } from '../models/product-model.entity';
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
      relations: [nameOf<ProductSourceRecord>('model')],
    });
  }

  /**
   * Cheap identity lookup by (source, externalId) — the source-native SKU/
   * model code/slug, stable across URL changes. Used ahead of full identity
   * resolution to recognize an already-known listing so extraction/LLM
   * unification can be skipped when its rawSpecsHash is unchanged.
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
      relations: [nameOf<ProductSourceRecord>('model')],
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

  async findAllByNormalizedName(
    normalizedSourceName: string,
    categoryId: string,
  ): Promise<ProductSourceRecord[]> {
    return this.repo
      .createQueryBuilder('source')
      .innerJoinAndSelect(
        `source.${nameOf<ProductSourceRecord>('model')}`,
        'model',
      )
      .innerJoinAndSelect(
        `model.${nameOf<ProductModel>('productCategory')}`,
        'category',
      )
      .leftJoinAndSelect(
        `model.${nameOf<ProductModel>('mainImage')}`,
        'mainImage',
      )
      .leftJoinAndSelect(`model.${nameOf<ProductModel>('images')}`, 'images')
      .leftJoinAndSelect(
        `model.${nameOf<ProductModel>('embedding')}`,
        'embedding',
      )
      .leftJoinAndSelect(`model.${nameOf<ProductModel>('sources')}`, 'sources')
      .where(
        `source.${nameOf<ProductSourceRecord>('normalizedSourceName')} = :normalizedSourceName`,
        { normalizedSourceName },
      )
      .andWhere('category.id = :categoryId', { categoryId })
      .getMany();
  }
}
