import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { isPlainObject } from 'lodash';
import { BasePostgresRepository } from './base-postgres-repository';
import { countByRelationIds } from './grouped-count';
import { ProductSourceRecord } from '../models/product-source-record.entity';
import { ProductSource } from '../models/product-source.entity';
import type { ProductModel } from '../models/product-model.entity';
import type { Seller } from '../models/seller.entity';
import type { Brand } from '../models/brand.entity';
import type { Offer } from '../models/offer.entity';
import type { ScrapedOffer, ScrapedProduct } from '../../models/scraped-product';
import type { ProductSpecs } from '../../models/product-spec';
import { nameOf, productDisplayNameSql } from '@fittkereso-backend/utils';

/** What a feed run knows about one of its listings before deciding on a row. */
export interface FeedRowState {
  feedRowHash: string | null;
  /** When the source last listed it (lastSeenAt, else lastUpdated). */
  seenAt: Date;
  /** The product it sits on; null while it is unattached. */
  modelId: string | null;
}

/** A listing of an identifying source, as findIdentifyingListingsInCategory reads it. */
export interface IdentifyingListingRow {
  id: string;
  /** The product it sits on; null while it is unattached. */
  modelId: string | null;
  sourceId: string;
  sourceName: string;
  sellerId: string;
  /** The stored listing without its spec table, description and images. */
  listing: Partial<ScrapedProduct>;
}

/** What a list of listings can be ordered by. */
export const PRODUCT_SOURCE_RECORD_SORTS = [
  'title',
  'brand',
  'productName',
  'sourceName',
  'externalId',
  'price',
  'seenAt',
  'lastUpdated',
  'createdAt',
] as const;
export type ProductSourceRecordSort = (typeof PRODUCT_SOURCE_RECORD_SORTS)[number];

export interface ProductSourceRecordFilter {
  productSourceId?: string;
  /** Any of these sources. */
  productSourceIds?: string[];
  sellerId?: string;
  /** True: on a product. False: unattached. Omitted: either. */
  attached?: boolean;
  /** True: specs valid. False: the listing failed spec validation. Omitted: either. */
  valid?: boolean;
  /** Matched against the URL, the externalIds and the title, case-insensitively. */
  search?: string;
  /** Matched against the name of the product the listing sits on. */
  productName?: string;
  /** Matched against the brand the listing states. */
  brand?: string;
  /** The category the listing was imported into, by id. */
  categoryIds?: string[];
  /** Default: newest sighting first. */
  sort?: ProductSourceRecordSort;
  order?: 'ASC' | 'DESC';
  skip?: number;
  take?: number;
}

/** One listing, as a list of them shows it. */
export interface ProductSourceRecordRow {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  sellerId: string | null;
  sellerName: string | null;
  url: string | null;
  externalId: string | null;
  /** The externalIds its offers are stored under. */
  offerExternalIds: string[];
  /** The listing's model, as the identity extraction named it. */
  model: string | null;
  /** The title exactly as the shop showed it; null on a record stored before it was kept. */
  originalName: string | null;
  brand: string | null;
  categoryName: string | null;
  categorySlug: string | null;
  /** Each offer entry's offer-level specs (size, colour…), for the entries that carry any. */
  offerEntrySpecs: ProductSpecs[];
  /** How many offer entries (sizes, colours…) the listing states. */
  offerCount: number;
  /** The lowest price among its offer entries. */
  price: number | null;
  /** That entry's old price, when it is discounted. */
  priceWithoutDiscount: number | null;
  currency: string | null;
  /** Of the entry at that price. */
  availability: string | null;
  specValid: boolean;
  productId: string | null;
  productName: string | null;
  /** The product's price: its cheapest active offer, across every seller. */
  productPrice: number | null;
  /** When its source last listed it (lastSeenAt, else lastUpdated). */
  seenAt: Date;
  lastUpdated: Date;
  createdAt: Date;
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
      nameOf<ProductSourceRecord>('product'),
      modelIds,
    );
  }

  /**
   * This source's record of a listing, by its key (listingExternalIdOf), with
   * its product and offers. The key is unique per source, and survives the
   * shop renaming the listing's URL.
   *
   * Source-scoped deliberately, and there is no unscoped variant: several
   * ProductSources can cover one webshop, and a bare match would hand one
   * source another source's row.
   */
  async findBySourceAndExternalId(
    sourceId: string,
    externalId: string,
  ): Promise<ProductSourceRecord | null> {
    return this.repo.findOne({
      where: { source: { id: sourceId }, externalId },
      relations: [nameOf<ProductSourceRecord>('product'), nameOf<ProductSourceRecord>('offers')],
    });
  }

  /**
   * A record of this source at this URL, with the same relations as
   * findBySourceAndExternalId. For what only knows a URL: dispatching a page,
   * and a list card without a usable id. URLs are not unique, so where two
   * listings share a page this is one of them.
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
      relations: [nameOf<ProductSourceRecord>('product'), nameOf<ProductSourceRecord>('offers')],
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Each of these listings' feed row hash, last sighting and product, for one
   * source, by listing key: a feed run's whole question about a row is whether
   * its listing already holds that hash, whether it had stopped counting as
   * current, and (for a contributing source) whether it waits unattached.
   */
  async findFeedRowStates(
    sourceId: string,
    externalIds: string[],
  ): Promise<Map<string, FeedRowState>> {
    if (externalIds.length === 0) return new Map();
    const records = await this.repo
      .createQueryBuilder('record')
      .select([
        `record.${nameOf<ProductSourceRecord>('id')}`,
        `record.${nameOf<ProductSourceRecord>('externalId')}`,
        `record.${nameOf<ProductSourceRecord>('feedRowHash')}`,
        `record.${nameOf<ProductSourceRecord>('lastSeenAt')}`,
        `record.${nameOf<ProductSourceRecord>('lastUpdated')}`,
      ])
      .leftJoin(`record.${nameOf<ProductSourceRecord>('product')}`, 'model')
      .addSelect('model.id')
      .where(`record."${nameOf<ProductSourceRecord>('source')}Id" = :sourceId`, {
        sourceId,
      })
      .andWhere(`record."${nameOf<ProductSourceRecord>('externalId')}" IN (:...externalIds)`, {
        externalIds,
      })
      .getMany();
    return new Map(
      records.map((record) => [
        record.externalId as string,
        {
          feedRowHash: record.feedRowHash ?? null,
          seenAt: record.lastSeenAt ?? record.lastUpdated,
          modelId: record.product?.id ?? null,
        },
      ]),
    );
  }

  /**
   * These listings of one source, by key, were seen again, unchanged: they
   * still count as current for OfferComposerService.
   */
  async stampSeen(sourceId: string, externalIds: string[]): Promise<void> {
    if (externalIds.length === 0) return;
    await this.repo
      .createQueryBuilder()
      .update(ProductSourceRecord)
      .set({ lastSeenAt: () => 'NOW()' })
      .where(`"${nameOf<ProductSourceRecord>('source')}Id" = :sourceId`, { sourceId })
      .andWhere(`"${nameOf<ProductSourceRecord>('externalId')}" IN (:...externalIds)`, {
        externalIds,
      })
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
      .where(`record."${nameOf<ProductSourceRecord>('product')}Id" IS NULL`)
      .andWhere('seller.id = :sellerId', { sellerId })
      .andWhere(
        `EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(record."${nameOf<ProductSourceRecord>('scrapedProduct')}" -> '${offers}', '[]'::jsonb)) AS entry WHERE entry ->> '${resolvedExternalId}' IN (:...externalIds))`,
        { externalIds },
      )
      .getMany();
  }

  /**
   * One listing with what the admin shows of it: its source and seller, the
   * offers it supplies the price of, and the product it sits on with that
   * product's category. The relations match a product's records on the
   * product details route.
   */
  async findDetailsById(id: string): Promise<ProductSourceRecord | null> {
    const source = nameOf<ProductSourceRecord>('source');
    const offers = nameOf<ProductSourceRecord>('offers');
    const product = nameOf<ProductSourceRecord>('product');
    return this.repo.findOne({
      where: { id },
      relations: [
        source,
        `${source}.${nameOf<ProductSource>('seller')}`,
        nameOf<ProductSourceRecord>('brand'),
        offers,
        `${offers}.${nameOf<Offer>('seller')}`,
        product,
        `${product}.${nameOf<ProductModel>('brand')}`,
        `${product}.${nameOf<ProductModel>('productCategory')}`,
      ],
    });
  }

  /** How many of this source's records wait unattached. */
  async countUnattached(sourceId: string): Promise<number> {
    return this.repo
      .createQueryBuilder('record')
      .where(`record."${nameOf<ProductSourceRecord>('source')}Id" = :sourceId`, { sourceId })
      .andWhere(`record."${nameOf<ProductSourceRecord>('product')}Id" IS NULL`)
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
      .set({ product: null })
      .where({ id: In(ids) })
      .execute();
  }

  /**
   * Listings by source or seller, attached or not, filtered by their title,
   * brand, category, product and spec validity. Newest sighting first unless
   * another sort is asked for.
   */
  async searchRecords(
    params: ProductSourceRecordFilter,
  ): Promise<{ items: ProductSourceRecordRow[]; total: number }> {
    const record = (column: keyof ProductSourceRecord) => `record."${nameOf<ProductSourceRecord>(column)}"`;
    const scraped = record('scrapedProduct');
    const originalName: keyof ScrapedProduct = 'originalName';
    const brand: keyof ScrapedProduct = 'brand';
    const category: keyof ScrapedProduct = 'category';
    const offers: keyof ScrapedProduct = 'offers';
    const price: keyof ScrapedOffer = 'price';
    const offerSpecs: keyof ScrapedOffer = 'specs';
    const seenAt = `COALESCE(${record('lastSeenAt')}, ${record('lastUpdated')})`;
    // What the list shows as the listing's title: its column, else the stored
    // listing's (a row written before the column existed).
    const shownTitle = `COALESCE(${record('originalTitle')}, ${scraped} ->> '${originalName}')`;
    const offerExternalIds = `jsonb_path_query_array(${scraped}, '$.${offers}[*].resolvedExternalId')`;
    const entries = `jsonb_array_elements(COALESCE(${scraped} -> '${offers}', '[]'::jsonb))`;
    // The entry a listing is priced by: its cheapest size or colour.
    const cheapest = `(SELECT entry FROM ${entries} AS entry ORDER BY (entry ->> '${price}')::numeric ASC NULLS LAST LIMIT 1)`;
    const cheapestField = (field: keyof ScrapedOffer) => `${cheapest} ->> '${field}'`;
    const productName = productDisplayNameSql(
      `productBrand.${nameOf<Brand>('name')}`,
      `model."${nameOf<ProductModel>('model')}"`,
    );

    const sortExpressions: Record<ProductSourceRecordSort, string> = {
      title: `LOWER(${shownTitle})`,
      brand: `LOWER(${scraped} ->> '${brand}')`,
      productName: `LOWER(${productName})`,
      sourceName: `LOWER(source.${nameOf<ProductSource>('name')})`,
      externalId: record('externalId'),
      price: `(${cheapestField('price')})::numeric`,
      seenAt,
      lastUpdated: record('lastUpdated'),
      createdAt: record('createdAt'),
    };

    const query = this.repo
      .createQueryBuilder('record')
      .innerJoin(`record.${nameOf<ProductSourceRecord>('source')}`, 'source')
      .leftJoin(`source.${nameOf<ProductSource>('seller')}`, 'seller')
      .leftJoin(`record.${nameOf<ProductSourceRecord>('product')}`, 'model')
      .leftJoin(`model.${nameOf<ProductModel>('brand')}`, 'productBrand');
    if (params.productSourceId) {
      query.andWhere('source.id = :sourceId', { sourceId: params.productSourceId });
    }
    if (params.productSourceIds?.length) {
      query.andWhere('source.id IN (:...sourceIds)', { sourceIds: params.productSourceIds });
    }
    if (params.sellerId) {
      query.andWhere(`source."${nameOf<ProductSource>('seller')}Id" = :sellerId`, {
        sellerId: params.sellerId,
      });
    }
    if (params.attached !== undefined) {
      query.andWhere(
        `record."${nameOf<ProductSourceRecord>('product')}Id" IS ${params.attached ? 'NOT NULL' : 'NULL'}`,
      );
    }
    if (params.valid !== undefined) {
      // A row written before validation existed holds null, and counts as valid.
      query.andWhere(`${record('specValid')} ${params.valid ? 'IS NOT FALSE' : 'IS FALSE'}`);
    }
    if (params.search) {
      query.andWhere(
        new Brackets((where) =>
          where
            .where(`record.${nameOf<ProductSourceRecord>('url')} ILIKE :search`)
            .orWhere(`${record('externalId')} ILIKE :search`)
            .orWhere(`${record('model')} ILIKE :search`)
            .orWhere(`${shownTitle} ILIKE :search`)
            .orWhere(`${offerExternalIds}::text ILIKE :search`),
        ),
        { search: `%${params.search}%` },
      );
    }
    if (params.productName) {
      query.andWhere(`${productName} ILIKE :productName`, {
        productName: `%${params.productName}%`,
      });
    }
    if (params.brand) {
      query.andWhere(`${scraped} ->> '${brand}' ILIKE :brand`, { brand: `%${params.brand}%` });
    }
    if (params.categoryIds?.length) {
      query.andWhere(`${scraped} -> '${category}' ->> 'id' IN (:...categoryIds)`, {
        categoryIds: params.categoryIds,
      });
    }

    const total = await query.getCount();
    const rows: (Omit<
      ProductSourceRecordRow,
      | 'offerExternalIds'
      | 'offerEntrySpecs'
      | 'price'
      | 'priceWithoutDiscount'
      | 'productPrice'
      | 'specValid'
    > & {
      offerExternalIds: (string | null)[] | null;
      offerEntrySpecs: unknown[] | null;
      price: string | null;
      priceWithoutDiscount: string | null;
      productPrice: string | null;
      specValid: boolean | null;
    })[] = await query
      .select('record.id', 'id')
      .addSelect('source.id', 'sourceId')
      .addSelect(`source.${nameOf<ProductSource>('name')}`, 'sourceName')
      .addSelect(`source.${nameOf<ProductSource>('type')}`, 'sourceType')
      .addSelect('seller.id', 'sellerId')
      .addSelect(`seller.${nameOf<Seller>('name')}`, 'sellerName')
      .addSelect(`record.${nameOf<ProductSourceRecord>('url')}`, 'url')
      .addSelect(record('externalId'), 'externalId')
      .addSelect(offerExternalIds, 'offerExternalIds')
      .addSelect(record('model'), 'model')
      .addSelect(shownTitle, 'originalName')
      .addSelect(`${scraped} ->> '${brand}'`, 'brand')
      .addSelect(`${scraped} -> '${category}' ->> 'name'`, 'categoryName')
      .addSelect(`${scraped} -> '${category}' ->> 'slug'`, 'categorySlug')
      .addSelect(
        `jsonb_path_query_array(${scraped}, '$.${offers}[*].${offerSpecs}')`,
        'offerEntrySpecs',
      )
      .addSelect(`jsonb_array_length(COALESCE(${scraped} -> '${offers}', '[]'::jsonb))`, 'offerCount')
      .addSelect(cheapestField('price'), 'price')
      .addSelect(cheapestField('priceWithoutDiscount'), 'priceWithoutDiscount')
      .addSelect(cheapestField('currency'), 'currency')
      .addSelect(cheapestField('availability'), 'availability')
      .addSelect(record('specValid'), 'specValid')
      .addSelect('model.id', 'productId')
      .addSelect(productName, 'productName')
      .addSelect(`model."${nameOf<ProductModel>('price')}"`, 'productPrice')
      .addSelect(seenAt, 'seenAt')
      .addSelect(record('lastUpdated'), 'lastUpdated')
      .addSelect(record('createdAt'), 'createdAt')
      .orderBy(sortExpressions[params.sort ?? 'seenAt'], params.order ?? 'DESC', 'NULLS LAST')
      .addOrderBy('record.id', 'ASC')
      .offset(params.skip ?? 0)
      .limit(params.take ?? 50)
      .getRawMany();

    const toNumber = (value: string | null | undefined) =>
      value === null || value === undefined ? null : Number(value);

    return {
      total,
      items: rows.map((row) => ({
        ...row,
        offerExternalIds: (row.offerExternalIds ?? []).filter(
          (id): id is string => typeof id === 'string',
        ),
        offerEntrySpecs: (row.offerEntrySpecs ?? []).filter(isPlainObject) as ProductSpecs[],
        offerCount: Number(row.offerCount ?? 0),
        price: toNumber(row.price),
        priceWithoutDiscount: toNumber(row.priceWithoutDiscount),
        productPrice: toNumber(row.productPrice),
        specValid: row.specValid !== false,
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
  /**
   * Every listing a product-identifying source has in this category, with
   * what a normalizedModel is built from: its stored listing (brand, names,
   * specs, offers — the spec table and description are left out), the
   * product it sits on, and its source and seller. For measuring matching
   * rules; nothing here writes.
   */
  async findIdentifyingListingsInCategory(
    categorySlug: string,
  ): Promise<IdentifyingListingRow[]> {
    const model = nameOf<ProductSourceRecord>('product');
    const source = nameOf<ProductSourceRecord>('source');
    const scraped = `record."${nameOf<ProductSourceRecord>('scrapedProduct')}"`;
    const seller = nameOf<ProductSource>('seller');
    const identifies = nameOf<ProductSource>('identifiesProducts');
    const heavy = [
      nameOf<ScrapedProduct>('rawSpecs'),
      nameOf<ScrapedProduct>('description'),
      nameOf<ScrapedProduct>('images'),
    ];

    return this.repo
      .createQueryBuilder('record')
      .select('record.id', 'id')
      .addSelect(`record."${model}Id"`, 'modelId')
      .addSelect('source.id', 'sourceId')
      .addSelect('source.name', 'sourceName')
      .addSelect(`source."${seller}Id"`, 'sellerId')
      .addSelect(`${scraped} - ARRAY[:...heavy]::text[]`, 'listing')
      .innerJoin(`record.${source}`, 'source')
      .where(`source."${identifies}" IS NOT FALSE`)
      .andWhere(`${scraped}->'${nameOf<ScrapedProduct>('category')}'->>'slug' = :categorySlug`, {
        categorySlug,
      })
      .setParameter('heavy', heavy)
      .getRawMany();
  }

  /**
   * One page of sources' listings, in id order after `afterId`, with their
   * source loaded — its config drives the extraction — their brand, and the
   * id of the product they sit on. `named`: only identifying
   * sources' listings with a stored extraction (a model). For the listing
   * model refresh.
   */
  async findForModelRefresh(params: {
    sourceId?: string;
    categorySlug?: string;
    /** Only these records. */
    recordIds?: string[];
    afterId?: string;
    limit: number;
    named: boolean;
  }): Promise<ProductSourceRecord[]> {
    const scraped = `record."${nameOf<ProductSourceRecord>('scrapedProduct')}"`;
    const query = this.repo
      .createQueryBuilder('record')
      .innerJoinAndSelect(`record.${nameOf<ProductSourceRecord>('source')}`, 'source')
      .leftJoin(`record.${nameOf<ProductSourceRecord>('product')}`, 'product')
      .addSelect('product.id')
      .leftJoinAndSelect(`record.${nameOf<ProductSourceRecord>('brand')}`, 'brand')
      .orderBy('record.id', 'ASC')
      .take(params.limit);

    if (params.named) {
      query
        .andWhere(`source."${nameOf<ProductSource>('identifiesProducts')}" IS NOT FALSE`)
        .andWhere(`${scraped}->>'${nameOf<ScrapedProduct>('model')}' IS NOT NULL`);
    }
    if (params.sourceId) query.andWhere('source.id = :sourceId', { sourceId: params.sourceId });
    if (params.recordIds) query.andWhere('record.id IN (:...recordIds)', { recordIds: params.recordIds });
    if (params.categorySlug) {
      query.andWhere(`${scraped}->'${nameOf<ScrapedProduct>('category')}'->>'slug' = :categorySlug`, {
        categorySlug: params.categorySlug,
      });
    }
    if (params.afterId) query.andWhere('record.id > :afterId', { afterId: params.afterId });
    return query.getMany();
  }

  /**
   * Writes a listing's model — the name and its contract into the stored
   * listing, the name and key into their columns — and `specs`, the values
   * the call read that the stored listing lacked: merged into its specs, a
   * stored value winning. A plain UPDATE rather than an entity save:
   * `lastUpdated` stays, and an import writing the record meanwhile keeps its
   * offers.
   */
  async setModel(
    id: string,
    values: { model: string; contract: string; key: string | null; specs?: ProductSpecs },
  ): Promise<void> {
    const scraped = `"${nameOf<ProductSourceRecord>('scrapedProduct')}"`;
    const key = `"${nameOf<ProductSourceRecord>('normalizedModel')}"`;
    const model = `"${nameOf<ProductSourceRecord>('model')}"`;
    const specs = nameOf<ScrapedProduct>('specs');
    await this.repo.query(
      `UPDATE ${this.repo.metadata.tableName}
          SET ${key} = $1,
              ${model} = $2::text,
              ${scraped} = COALESCE(${scraped}, '{}'::jsonb) || jsonb_build_object(
                '${nameOf<ScrapedProduct>('model')}', $2::text,
                '${nameOf<ScrapedProduct>('modelContract')}', $3::text,
                '${specs}', $4::jsonb || COALESCE(${scraped}->'${specs}', '{}'::jsonb))
        WHERE id = $5`,
      [values.key, values.model, values.contract, JSON.stringify(values.specs ?? {}), id],
    );
  }

  /**
   * Writes the columns a listing's record keeps beside its stored listing —
   * its resolved brand, model, title and key — and nothing else. A plain
   * UPDATE, so `lastUpdated` stays.
   */
  async setListingColumns(
    id: string,
    values: {
      brandId: string | null;
      model: string | null;
      originalTitle: string | null;
      normalizedModel: string | null;
    },
  ): Promise<void> {
    const column = (field: keyof ProductSourceRecord) => `"${nameOf<ProductSourceRecord>(field)}"`;
    await this.repo.query(
      `UPDATE ${this.repo.metadata.tableName}
          SET "${nameOf<ProductSourceRecord>('brand')}Id" = $1,
              ${column('model')} = $2,
              ${column('originalTitle')} = $3,
              ${column('normalizedModel')} = $4
        WHERE id = $5`,
      [values.brandId, values.model, values.originalTitle, values.normalizedModel, id],
    );
  }

  /**
   * Each product's keys: the normalizedModels of its identifying sources'
   * listings (a contributing source's listing stores none). A product without
   * one is absent from the map.
   */
  async findNormalizedModelsByProductIds(productIds: string[]): Promise<Map<string, string[]>> {
    const keys = new Map<string, string[]>();
    if (productIds.length === 0) return keys;

    const product = `"${nameOf<ProductSourceRecord>('product')}Id"`;
    const key = `"${nameOf<ProductSourceRecord>('normalizedModel')}"`;
    const rows: { productId: string; keys: string[] }[] = await this.repo.query(
      `SELECT ${product} AS "productId", array_agg(DISTINCT ${key}) AS keys
         FROM ${this.repo.metadata.tableName}
        WHERE ${product} = ANY($1::uuid[]) AND ${key} IS NOT NULL
        GROUP BY ${product}`,
      [productIds],
    );
    for (const row of rows) keys.set(row.productId, row.keys);
    return keys;
  }

  async findModelIdsWithStaleContributors(params: {
    visibleCutoff: Date;
    deleteCutoff: Date;
    limit: number;
  }): Promise<string[]> {
    const model = nameOf<ProductSourceRecord>('product');
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
   * Identity lookup by (source, externalId) — the listing's key, stable
   * across URL changes — with `model` loaded via the given relations so the
   * result can be used directly as a resolved ProductModel (see
   * ProductScrapeUpdaterService Path 3).
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
        nameOf<ProductSourceRecord>('product'),
        ...modelRelations.map(
          (relation) => `${nameOf<ProductSourceRecord>('product')}.${relation}`,
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
      relations: { product: true },
      select: { id: true, externalId: true, product: { id: true } },
    });
    return records.flatMap((record) =>
      record.product && record.externalId
        ? [{ modelId: record.product.id, externalId: record.externalId }]
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
      .where(`${record}.${nameOf<ProductSourceRecord>('product')} = :modelId`, { modelId })
      .getRawMany();

    return rows.flatMap((row) =>
      Array.isArray(row.siblingIds) && row.siblingIds.length > 0
        ? [{ sourceId: row.sourceId, siblingIds: row.siblingIds.map(String) }]
        : [],
    );
  }
}
