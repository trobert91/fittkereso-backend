import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { countByRelationIds } from './grouped-count';
import { ProductSourceRecord } from '../models/product-source-record.entity';
import { ProductSource } from '../models/product-source.entity';
import type { ScrapedOffer, ScrapedProduct } from '../../models/scraped-product';
import { nameOf } from '@fittkereso-backend/utils';

/** What a feed run knows about one of its listings before deciding on a row. */
export interface FeedRowState {
  feedRowHash: string | null;
  /** When the source last listed it (lastSeenAt, else lastUpdated). */
  seenAt: Date;
  /** The product it sits on; null while it is unattached. */
  modelId: string | null;
}

export interface ProductSourceRecordSearchParams {
  productSourceId?: string;
  sellerId?: string;
  /** True: on a product. False: unattached. Omitted: either. */
  attached?: boolean;
  /** Matched against the URL, the externalIds and the title, case-insensitively. */
  search?: string;
  skip?: number;
  take?: number;
}

/** One listing, as a list of them shows it. */
export interface ProductSourceRecordRow {
  id: string;
  sourceId: string;
  sourceName: string;
  url: string | null;
  externalId: string | null;
  /** The externalIds its offers are stored under. */
  offerExternalIds: string[];
  title: string | null;
  price: number | null;
  productId: string | null;
  productName: string | null;
  /** When its source last listed it (lastSeenAt, else lastUpdated). */
  seenAt: Date;
}

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
   * Each of these URLs' feed row hash, last sighting and product, for one
   * source: a feed run's whole question about a row is whether its listing
   * already holds that hash, whether it had stopped counting as current, and
   * (for a contributing source) whether it waits unattached.
   */
  async findFeedRowStates(
    sourceId: string,
    urls: string[],
  ): Promise<Map<string, FeedRowState>> {
    if (urls.length === 0) return new Map();
    const records = await this.repo
      .createQueryBuilder('record')
      .select([
        `record.${nameOf<ProductSourceRecord>('id')}`,
        `record.${nameOf<ProductSourceRecord>('url')}`,
        `record.${nameOf<ProductSourceRecord>('feedRowHash')}`,
        `record.${nameOf<ProductSourceRecord>('lastSeenAt')}`,
        `record.${nameOf<ProductSourceRecord>('lastUpdated')}`,
      ])
      .leftJoin(`record.${nameOf<ProductSourceRecord>('model')}`, 'model')
      .addSelect('model.id')
      .where(`record."${nameOf<ProductSourceRecord>('source')}Id" = :sourceId`, {
        sourceId,
      })
      .andWhere(`record.${nameOf<ProductSourceRecord>('url')} IN (:...urls)`, { urls })
      .getMany();
    return new Map(
      records.map((record) => [
        record.url as string,
        {
          feedRowHash: record.feedRowHash ?? null,
          seenAt: record.lastSeenAt ?? record.lastUpdated,
          modelId: record.model?.id ?? null,
        },
      ]),
    );
  }

  /**
   * These listings of one source were seen again, unchanged: they still count
   * as current for OfferComposerService.
   */
  async stampSeen(sourceId: string, urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    await this.repo
      .createQueryBuilder()
      .update(ProductSourceRecord)
      .set({ lastSeenAt: () => 'NOW()' })
      .where(`"${nameOf<ProductSourceRecord>('source')}Id" = :sourceId`, { sourceId })
      .andWhere(`${nameOf<ProductSourceRecord>('url')} IN (:...urls)`, { urls })
      .execute();
  }

  /**
   * A seller's unattached records that carry one of these offer externalIds:
   * the rows its contributing sources stored before the offer existed, which
   * the identifying listing writing that offer now attaches. With each source
   * and its seller, as a product's records are loaded.
   */
  async findUnattachedBySellerAndExternalIds(
    sellerId: string,
    externalIds: string[],
  ): Promise<ProductSourceRecord[]> {
    if (externalIds.length === 0) return [];
    const offers: keyof ScrapedProduct = 'offers';
    const resolvedExternalId: keyof ScrapedOffer = 'resolvedExternalId';
    return this.repo
      .createQueryBuilder('record')
      .innerJoinAndSelect(`record.${nameOf<ProductSourceRecord>('source')}`, 'source')
      .innerJoinAndSelect(`source.${nameOf<ProductSource>('seller')}`, 'seller')
      .where(`record."${nameOf<ProductSourceRecord>('model')}Id" IS NULL`)
      .andWhere('seller.id = :sellerId', { sellerId })
      .andWhere(
        `EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(record."${nameOf<ProductSourceRecord>('scrapedProduct')}" -> '${offers}', '[]'::jsonb)) AS entry WHERE entry ->> '${resolvedExternalId}' IN (:...externalIds))`,
        { externalIds },
      )
      .getMany();
  }

  /** How many of this source's records wait unattached. */
  async countUnattached(sourceId: string): Promise<number> {
    return this.repo
      .createQueryBuilder('record')
      .where(`record."${nameOf<ProductSourceRecord>('source')}Id" = :sourceId`, { sourceId })
      .andWhere(`record."${nameOf<ProductSourceRecord>('model')}Id" IS NULL`)
      .getCount();
  }

  /**
   * Takes these records off their product. Explicit, because saving the
   * product without them never does (orphanedRowAction 'disable').
   */
  async detach(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.repo
      .createQueryBuilder()
      .update(ProductSourceRecord)
      .set({ model: null })
      .where({ id: In(ids) })
      .execute();
  }

  /** Listings by source or seller, attached or not, newest sighting first. */
  async searchRecords(
    params: ProductSourceRecordSearchParams,
  ): Promise<{ items: ProductSourceRecordRow[]; total: number }> {
    const scraped = `record."${nameOf<ProductSourceRecord>('scrapedProduct')}"`;
    const seenAt = `COALESCE(record."${nameOf<ProductSourceRecord>('lastSeenAt')}", record."${nameOf<ProductSourceRecord>('lastUpdated')}")`;
    const offerExternalIds = `jsonb_path_query_array(${scraped}, '$.offers[*].resolvedExternalId')`;

    const query = this.repo
      .createQueryBuilder('record')
      .innerJoin(`record.${nameOf<ProductSourceRecord>('source')}`, 'source')
      .leftJoin(`record.${nameOf<ProductSourceRecord>('model')}`, 'model');
    if (params.productSourceId) {
      query.andWhere('source.id = :sourceId', { sourceId: params.productSourceId });
    }
    if (params.sellerId) {
      query.andWhere(`source."${nameOf<ProductSource>('seller')}Id" = :sellerId`, {
        sellerId: params.sellerId,
      });
    }
    if (params.attached !== undefined) {
      query.andWhere(
        `record."${nameOf<ProductSourceRecord>('model')}Id" IS ${params.attached ? 'NOT NULL' : 'NULL'}`,
      );
    }
    if (params.search) {
      query.andWhere(
        new Brackets((where) =>
          where
            .where(`record.${nameOf<ProductSourceRecord>('url')} ILIKE :search`)
            .orWhere(`record."${nameOf<ProductSourceRecord>('externalId')}" ILIKE :search`)
            .orWhere(`${scraped} ->> 'displayName' ILIKE :search`)
            .orWhere(`${offerExternalIds}::text ILIKE :search`),
        ),
        { search: `%${params.search}%` },
      );
    }

    const total = await query.getCount();
    const rows: (Omit<ProductSourceRecordRow, 'offerExternalIds' | 'price'> & {
      offerExternalIds: (string | null)[] | null;
      price: string | null;
    })[] = await query
      .select('record.id', 'id')
      .addSelect('source.id', 'sourceId')
      .addSelect(`source.${nameOf<ProductSource>('name')}`, 'sourceName')
      .addSelect(`record.${nameOf<ProductSourceRecord>('url')}`, 'url')
      .addSelect(`record."${nameOf<ProductSourceRecord>('externalId')}"`, 'externalId')
      .addSelect(offerExternalIds, 'offerExternalIds')
      .addSelect(`${scraped} ->> 'displayName'`, 'title')
      .addSelect(`${scraped} -> 'offers' -> 0 ->> 'price'`, 'price')
      .addSelect('model.id', 'productId')
      .addSelect('model."displayName"', 'productName')
      .addSelect(seenAt, 'seenAt')
      .orderBy('"seenAt"', 'DESC')
      .addOrderBy('record.id', 'ASC')
      .offset(params.skip ?? 0)
      .limit(params.take ?? 50)
      .getRawMany();

    return {
      total,
      items: rows.map((row) => ({
        ...row,
        offerExternalIds: (row.offerExternalIds ?? []).filter(
          (id): id is string => typeof id === 'string',
        ),
        price: row.price === null ? null : Number(row.price),
      })),
    };
  }

  /**
   * Products whose offers need composing again because one of a seller's
   * sources stopped listing them while another still does: a record that fell
   * out of the visible window (but not yet past the delete cutoff, so each is
   * picked up for a bounded number of nightly runs), next to a current record
   * of the same seller on the same product.
   */
  async findModelIdsWithStaleContributors(params: {
    visibleCutoff: Date;
    deleteCutoff: Date;
    limit: number;
  }): Promise<string[]> {
    const model = nameOf<ProductSourceRecord>('model');
    const source = nameOf<ProductSourceRecord>('source');
    const seller = nameOf<ProductSource>('seller');
    const seenAt = (alias: string) =>
      `COALESCE(${alias}."${nameOf<ProductSourceRecord>('lastSeenAt')}", ${alias}."${nameOf<ProductSourceRecord>('lastUpdated')}")`;

    const rows: { modelId: string }[] = await this.repo
      .createQueryBuilder('stale')
      .select(`stale."${model}Id"`, 'modelId')
      .distinct(true)
      .innerJoin(`stale.${source}`, 'staleSource')
      .innerJoin(
        ProductSourceRecord,
        'fresh',
        `fresh."${model}Id" = stale."${model}Id" AND fresh.id <> stale.id`,
      )
      .innerJoin(
        `fresh.${source}`,
        'freshSource',
        `"freshSource"."${seller}Id" = "staleSource"."${seller}Id"`,
      )
      .where(`${seenAt('stale')} < :visibleCutoff`, { visibleCutoff: params.visibleCutoff })
      .andWhere(`${seenAt('stale')} >= :deleteCutoff`, { deleteCutoff: params.deleteCutoff })
      .andWhere(`${seenAt('fresh')} >= :visibleCutoff`)
      .limit(params.limit)
      .getRawMany();

    return rows.map((row) => row.modelId);
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
