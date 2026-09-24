import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { countByRelationIds } from './grouped-count';
import { ProductSourceRecord } from '../models/product-source-record.entity';
import type { ScrapedProduct } from '../../models/scraped-product';
import { nameOf } from '@fittkereso-backend/utils';

@Injectable()
export class ProductSourceRecordRepository extends BasePostgresRepository<ProductSourceRecord> {
  constructor(
    @InjectRepository(ProductSourceRecord, 'postgres')
    repository: Repository<ProductSourceRecord>,
  ) {
    super(repository, ProductSourceRecord);
  }

  /** How many listings sit on each of these products, in one query. */
  async countByModelIds(modelIds: string[]): Promise<Map<string, number>> {
    return countByRelationIds(
      this.repo,
      nameOf<ProductSourceRecord>('model'),
      modelIds,
    );
  }

  /**
   * Find this source's record for a URL.
   *
   * Source-scoped deliberately, and there is no unscoped variant: several
   * ProductSources can cover one webshop (a page scraper plus an Árukereső
   * feed), so `url` alone identifies a product page, not a record. A bare url
   * match would hand one source another source's row — and writing through it
   * overwrites that source's specs, hashes and externalId while the row stays
   * attributed to its original owner.
   *
   * `url` is expected normalized (see normalizeUrl); the column is written
   * that way by ProductSourceRecordUpdaterService.
   */
  async findBySourceAndUrl(
    sourceId: string,
    url: string,
  ): Promise<ProductSourceRecord | null> {
    return this.repo.findOne({
      where: { source: { id: sourceId }, url },
      relations: [nameOf<ProductSourceRecord>('model'), nameOf<ProductSourceRecord>('offers')],
    });
  }

  /**
   * Identity lookup by (source, externalId) — the source-native SKU/model
   * code/slug, stable across URL changes — with `model` loaded via the given
   * relations so the result can be used directly as a resolved ProductModel
   * (see ProductScrapeUpdaterService Path 3).
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
   * Which products hold one of this source's records under these externalIds —
   * the declared-sibling lookup: the other sizes a shop lists for a product,
   * wherever this source has already put them.
   */
  async findModelIdsBySourceAndExternalIds(
    sourceId: string,
    externalIds: string[],
  ): Promise<{ modelId: string; externalId: string }[]> {
    if (externalIds.length === 0) return [];
    const records = await this.repo.find({
      where: { source: { id: sourceId }, externalId: In(externalIds) },
      relations: { model: true },
      select: { id: true, externalId: true, model: { id: true } },
    });
    return records.flatMap((record) =>
      record.model && record.externalId
        ? [{ modelId: record.model.id, externalId: record.externalId }]
        : [],
    );
  }

  /**
   * The sizes each of a product's listings declared as siblings, by source.
   * Reads that one key of `scrapedProduct` rather than the whole payload, since
   * the nightly duplicate scan asks this of every product.
   */
  async findDeclaredSiblingIdsOfModel(
    modelId: string,
  ): Promise<{ sourceId: string; siblingIds: string[] }[]> {
    const record = 'record';
    const source = 'source';
    const siblingExternalIds: keyof ScrapedProduct = 'siblingExternalIds';
    const rows: { sourceId: string; siblingIds: unknown }[] = await this.repo
      .createQueryBuilder(record)
      .innerJoin(`${record}.${nameOf<ProductSourceRecord>('source')}`, source)
      .select(`${source}.id`, 'sourceId')
      .addSelect(
        `${record}.${nameOf<ProductSourceRecord>('scrapedProduct')} -> '${siblingExternalIds}'`,
        'siblingIds',
      )
      .where(`${record}.${nameOf<ProductSourceRecord>('model')} = :modelId`, { modelId })
      .getRawMany();

    return rows.flatMap((row) =>
      Array.isArray(row.siblingIds) && row.siblingIds.length > 0
        ? [{ sourceId: row.sourceId, siblingIds: row.siblingIds.map(String) }]
        : [],
    );
  }
}
