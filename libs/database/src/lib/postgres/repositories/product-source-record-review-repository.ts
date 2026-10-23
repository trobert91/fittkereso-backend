import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { ProductSourceRecord } from '../models/product-source-record.entity';
import type { ProductModel } from '../models/product-model.entity';
import type { ScrapedOffer, ScrapedProduct } from '../../models/scraped-product';

/** Where a spec key was counted (see specKeyCounts). */
export type SpecKeyLayer = 'extracted' | 'specs' | 'product' | 'offer';

/** One source's listings in one category, counted. */
export interface ListingCountRow {
  sourceId: string;
  /** The category the listing was imported into; null on a listing without one. */
  slug: string | null;
  listings: number;
  attached: number;
  /** Distinct products its attached listings sit on. */
  products: number;
  specInvalid: number;
  identityFailed: number;
  identityOff: number;
  pageRead: number;
  pageFailed: number;
}

/** How many of a source's attached listings in a category carry a spec key, in one layer. */
export interface SpecKeyCountRow {
  sourceId: string;
  slug: string | null;
  layer: SpecKeyLayer;
  key: string;
  /** Listings (products for the `product` layer) with a non-empty value. */
  count: number;
}

/** What a source's listings saved besides specs. */
export interface SavedFieldCountRow {
  sourceId: string;
  listings: number;
  withImages: number;
  imagesMedian: number;
  withDescription: number;
  descriptionMedianLength: number;
  withAliases: number;
  withSiblings: number;
  withExternalId: number;
  offerEntries: number;
  /** Per ScrapedOffer field: a value, mapped but null, or not mapped at all (absent). */
  offerFields: { field: string; value: number; mappedNull: number; notMapped: number }[];
}

/** One spec-row label across a source's listings. */
export interface RawSpecLabelRow {
  sourceId: string;
  slug: string | null;
  name: string;
  sectionTitle: string | null;
  /** Listings carrying the row (their merged rawSpecs). */
  count: number;
  /** Of those, how many have it from their product page (scrapedProduct.page.rawSpecs). */
  pageCount: number;
  /** Up to three distinct first values. */
  examples: string[];
}

/** A source's listing key, for comparing a feed with what was imported from it. */
export interface SourceListingKey {
  externalId: string | null;
  attached: boolean;
  seenAt: Date;
}

const OFFER_FIELDS: (keyof ScrapedOffer)[] = [
  'price',
  'priceWithoutDiscount',
  'currency',
  'availability',
  'condition',
  'gtin',
  'mpn',
];

/**
 * Read-only aggregates over a source's listings for a review of what it
 * imports: spec coverage by layer, saved fields, spec-row labels, and a
 * deterministic slice of listings. Kept apart from
 * ProductSourceRecordRepository, which serves the import path.
 */
@Injectable()
export class ProductSourceRecordReviewRepository {
  constructor(
    @InjectRepository(ProductSourceRecord, 'postgres')
    private readonly repo: Repository<ProductSourceRecord>,
  ) {}

  /** Listings, attached listings and products per source and category, with problem counts. */
  async listingCounts(sourceIds: string[], categorySlug?: string): Promise<ListingCountRow[]> {
    const sp = `l.sp`;
    const rows: Record<string, string | null>[] = await this.repo.query(
      `${this.listingsCte(false)}
       SELECT l.sid AS "sourceId", l.slug,
         COUNT(*)::int AS listings,
         COUNT(l.pid)::int AS attached,
         COUNT(DISTINCT l.pid)::int AS products,
         COUNT(*) FILTER (WHERE l.valid IS FALSE)::int AS "specInvalid",
         COUNT(*) FILTER (WHERE ${sp} -> '${key('flags')}' @> '["identity_failed"]')::int AS "identityFailed",
         COUNT(*) FILTER (WHERE ${sp} -> '${key('flags')}' @> '["identity_off"]')::int AS "identityOff",
         COUNT(*) FILTER (WHERE l."pageFetchedAt" IS NOT NULL)::int AS "pageRead",
         COUNT(*) FILTER (WHERE l."pageFailedAt" IS NOT NULL)::int AS "pageFailed"
       FROM l GROUP BY l.sid, l.slug ORDER BY l.sid, l.slug`,
      [sourceIds, categorySlug ?? null],
    );
    return rows.map((row) => ({
      sourceId: String(row['sourceId']),
      slug: row['slug'],
      listings: Number(row['listings']),
      attached: Number(row['attached']),
      products: Number(row['products']),
      specInvalid: Number(row['specInvalid']),
      identityFailed: Number(row['identityFailed']),
      identityOff: Number(row['identityOff']),
      pageRead: Number(row['pageRead']),
      pageFailed: Number(row['pageFailed']),
    }));
  }

  /**
   * For each spec key, how many attached listings carry it: in their
   * deterministic mapping (`extracted`), after the LLM (`specs`), in an offer
   * entry's specs (`offer`), and how many of their products carry it
   * (`product`, whichever seller filled it).
   */
  async specKeyCounts(sourceIds: string[], categorySlug?: string): Promise<SpecKeyCountRow[]> {
    const nonEmpty = (value: string) =>
      `jsonb_typeof(${value}) <> 'null' AND ${value} NOT IN ('""'::jsonb, '[]'::jsonb)`;
    const product = this.productTable();
    const specs = nameOf<ProductModel>('specs');
    const rows: Record<string, string | null>[] = await this.repo.query(
      `${this.listingsCte(true)}
       SELECT l.sid AS "sourceId", l.slug, 'extracted' AS layer, e.key, COUNT(*)::int AS count
         FROM l, jsonb_each(${asObject(`l.sp -> '${key('extractedSpecs')}'`)}) e
         WHERE ${nonEmpty('e.value')} GROUP BY 1, 2, 3, 4
       UNION ALL
       SELECT l.sid, l.slug, 'specs', e.key, COUNT(*)::int
         FROM l, jsonb_each(${asObject(`l.sp -> '${key('specs')}'`)}) e
         WHERE ${nonEmpty('e.value')} GROUP BY 1, 2, 3, 4
       UNION ALL
       SELECT l.sid, l.slug, 'offer', e.key, COUNT(DISTINCT l.id)::int
         FROM l, jsonb_array_elements(${asArray(`l.sp -> '${key('offers')}'`)}) o,
              jsonb_each(${asObject(`o -> '${offerKey('specs')}'`)}) e
         WHERE ${nonEmpty('e.value')} GROUP BY 1, 2, 3, 4
       UNION ALL
       SELECT l.sid, l.slug, 'product', e.key, COUNT(DISTINCT l.pid)::int
         FROM l JOIN "${product}" m ON m.id = l.pid,
              jsonb_each(${asObject(`m."${specs}"`)}) e
         WHERE ${nonEmpty('e.value')} GROUP BY 1, 2, 3, 4`,
      [sourceIds, categorySlug ?? null],
    );
    return rows.map((row) => ({
      sourceId: String(row['sourceId']),
      slug: row['slug'],
      layer: row['layer'] as SpecKeyLayer,
      key: String(row['key']),
      count: Number(row['count']),
    }));
  }

  /** Images, descriptions, aliases, siblings and each offer field, per source. */
  async savedFieldCounts(sourceIds: string[], categorySlug?: string): Promise<SavedFieldCountRow[]> {
    const images = `jsonb_array_length(${asArray(`l.sp -> '${key('images')}'`)})`;
    const description = `length(COALESCE(l.sp ->> '${key('description')}', ''))`;
    const listingRows: Record<string, string | number | null>[] = await this.repo.query(
      `${this.listingsCte(false)}
       SELECT l.sid AS "sourceId", COUNT(*)::int AS listings,
         COUNT(*) FILTER (WHERE ${images} > 0)::int AS "withImages",
         COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${images}), 0) AS "imagesMedian",
         COUNT(*) FILTER (WHERE ${description} > 0)::int AS "withDescription",
         COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${description}) FILTER (WHERE ${description} > 0), 0) AS "descriptionMedianLength",
         COUNT(*) FILTER (WHERE jsonb_array_length(${asArray(`l.sp -> '${key('aliases')}'`)}) > 0)::int AS "withAliases",
         COUNT(*) FILTER (WHERE jsonb_array_length(${asArray(`l.sp -> '${key('siblingExternalIds')}'`)}) > 0)::int AS "withSiblings",
         COUNT(*) FILTER (WHERE l."externalId" IS NOT NULL)::int AS "withExternalId",
         SUM(jsonb_array_length(${asArray(`l.sp -> '${key('offers')}'`)}))::int AS "offerEntries"
       FROM l GROUP BY l.sid`,
      [sourceIds, categorySlug ?? null],
    );
    const fieldRows: Record<string, string | number>[] = await this.repo.query(
      `${this.listingsCte(false)}
       SELECT l.sid AS "sourceId", f.field,
         COUNT(*) FILTER (WHERE jsonb_typeof(o -> f.field) NOT IN ('null') AND COALESCE(o ->> f.field, '') <> '')::int AS value,
         COUNT(*) FILTER (WHERE jsonb_typeof(o -> f.field) = 'null')::int AS "mappedNull",
         COUNT(*) FILTER (WHERE o -> f.field IS NULL)::int AS "notMapped"
       FROM l, jsonb_array_elements(${asArray(`l.sp -> '${key('offers')}'`)}) o, unnest($3::text[]) AS f(field)
       GROUP BY l.sid, f.field`,
      [sourceIds, categorySlug ?? null, OFFER_FIELDS],
    );
    return listingRows.map((row) => {
      const sourceId = String(row['sourceId']);
      return {
        sourceId,
        listings: Number(row['listings']),
        withImages: Number(row['withImages']),
        imagesMedian: Number(row['imagesMedian']),
        withDescription: Number(row['withDescription']),
        descriptionMedianLength: Number(row['descriptionMedianLength']),
        withAliases: Number(row['withAliases']),
        withSiblings: Number(row['withSiblings']),
        withExternalId: Number(row['withExternalId']),
        offerEntries: Number(row['offerEntries'] ?? 0),
        offerFields: OFFER_FIELDS.map((field) => {
          const found = fieldRows.find(
            (fieldRow) => fieldRow['sourceId'] === sourceId && fieldRow['field'] === field,
          );
          return {
            field,
            value: Number(found?.['value'] ?? 0),
            mappedNull: Number(found?.['mappedNull'] ?? 0),
            notMapped: Number(found?.['notMapped'] ?? 0),
          };
        }),
      };
    });
  }

  /**
   * Every spec-row label a source's listings carry (their merged rawSpecs:
   * a feed listing's rows, then its page's), with how many listings carry it,
   * how many of those from the page, and example values.
   */
  async rawSpecLabelCounts(sourceIds: string[], categorySlug?: string): Promise<RawSpecLabelRow[]> {
    const rows: Record<string, unknown>[] = await this.repo.query(
      `${this.listingsCte(false)},
       own AS (
         SELECT l.sid, l.slug, l.id, x ->> 'name' AS name,
           COALESCE(x ->> 'sectionTitle', '') AS section, x -> 'values' ->> 0 AS first
         FROM l, jsonb_array_elements(${asArray(`l.sp -> '${key('rawSpecs')}'`)}) x
       ),
       page AS (
         SELECT DISTINCT l.id, x ->> 'name' AS name, COALESCE(x ->> 'sectionTitle', '') AS section
         FROM l, jsonb_array_elements(${asArray(`l.sp -> '${key('page')}' -> 'rawSpecs'`)}) x
       )
       SELECT own.sid AS "sourceId", own.slug, own.name,
         NULLIF(own.section, '') AS "sectionTitle",
         COUNT(DISTINCT own.id)::int AS count,
         COUNT(DISTINCT own.id) FILTER (WHERE page.id IS NOT NULL)::int AS "pageCount",
         (array_agg(DISTINCT left(own.first, 120)) FILTER (WHERE COALESCE(own.first, '') <> ''))[1:3] AS examples
       FROM own
       LEFT JOIN page ON page.id = own.id AND page.name = own.name AND page.section = own.section
       WHERE COALESCE(own.name, '') <> ''
       GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, count DESC, 3`,
      [sourceIds, categorySlug ?? null],
    );
    return rows.map((row) => ({
      sourceId: String(row['sourceId']),
      slug: (row['slug'] as string | null) ?? null,
      name: String(row['name']),
      sectionTitle: (row['sectionTitle'] as string | null) ?? null,
      count: Number(row['count']),
      pageCount: Number(row['pageCount']),
      examples: ((row['examples'] as string[] | null) ?? []).filter(Boolean),
    }));
  }

  /**
   * One slice of a source's listings in a stable order: by their product's
   * publicId (random but fixed, so evenly spaced slices are a random sample
   * and two reads see the same listings), unattached ones last, then by id.
   * Each with its product, the product's brand and category.
   */
  async listingSlice(params: {
    sourceId: string;
    categorySlug?: string;
    includeUnattached?: boolean;
    offset: number;
    limit: number;
  }): Promise<{ total: number; records: ProductSourceRecord[] }> {
    const productId = `record."${nameOf<ProductSourceRecord>('product')}Id"`;
    const query = this.repo
      .createQueryBuilder('record')
      .leftJoin(`record.${nameOf<ProductSourceRecord>('product')}`, 'model')
      .where(`record."${nameOf<ProductSourceRecord>('source')}Id" = :sourceId`, {
        sourceId: params.sourceId,
      });
    if (!params.includeUnattached) query.andWhere(`${productId} IS NOT NULL`);
    if (params.categorySlug) {
      query.andWhere(
        `record."${nameOf<ProductSourceRecord>('scrapedProduct')}" -> '${key('category')}' ->> 'slug' = :slug`,
        { slug: params.categorySlug },
      );
    }
    const total = await query.getCount();
    const ids: { id: string }[] = await query
      .select('record.id', 'id')
      .orderBy(`model."${nameOf<ProductModel>('publicId')}"`, 'ASC', 'NULLS LAST')
      .addOrderBy('record.id', 'ASC')
      .offset(params.offset)
      .limit(params.limit)
      .getRawMany();
    if (ids.length === 0) return { total, records: [] };

    const records = await this.repo.find({
      where: { id: In(ids.map((row) => row.id)) },
      relations: { product: { brand: true, productCategory: true } },
    });
    const order = new Map(ids.map((row, index) => [row.id, index]));
    records.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return { total, records };
  }

  /** Every listing key of a source, attached or not, with its last sighting. */
  async listingKeys(sourceId: string): Promise<SourceListingKey[]> {
    const rows: { externalId: string | null; attached: boolean; seenAt: Date }[] = await this.repo
      .createQueryBuilder('record')
      .select(`record."${nameOf<ProductSourceRecord>('externalId')}"`, 'externalId')
      .addSelect(`record."${nameOf<ProductSourceRecord>('product')}Id" IS NOT NULL`, 'attached')
      .addSelect(
        `COALESCE(record."${nameOf<ProductSourceRecord>('lastSeenAt')}", record."${nameOf<ProductSourceRecord>('lastUpdated')}")`,
        'seenAt',
      )
      .where(`record."${nameOf<ProductSourceRecord>('source')}Id" = :sourceId`, { sourceId })
      .getRawMany();
    return rows.map((row) => ({
      externalId: row.externalId,
      attached: row.attached === true || String(row.attached) === 'true',
      seenAt: new Date(row.seenAt),
    }));
  }

  /**
   * `l`: the listings of these sources (`$1`), in one category when `$2` is
   * set, attached only when asked, with the columns the aggregates read.
   */
  private listingsCte(attachedOnly: boolean): string {
    const column = (name: keyof ProductSourceRecord) => `r."${nameOf<ProductSourceRecord>(name)}"`;
    const scraped = column('scrapedProduct');
    return `WITH l AS (
      SELECT r.id,
        r."${nameOf<ProductSourceRecord>('source')}Id" AS sid,
        r."${nameOf<ProductSourceRecord>('product')}Id" AS pid,
        ${scraped} AS sp,
        ${scraped} -> '${key('category')}' ->> 'slug' AS slug,
        ${column('specValid')} AS valid,
        ${column('externalId')} AS "externalId",
        ${column('pageFetchedAt')} AS "pageFetchedAt",
        ${column('pageFailedAt')} AS "pageFailedAt"
      FROM "${this.repo.metadata.tableName}" r
      WHERE r."${nameOf<ProductSourceRecord>('source')}Id" = ANY($1::uuid[])
        AND ($2::text IS NULL OR ${scraped} -> '${key('category')}' ->> 'slug' = $2)
        ${attachedOnly ? `AND r."${nameOf<ProductSourceRecord>('product')}Id" IS NOT NULL` : ''}
    )`;
  }

  private productTable(): string {
    const relation = this.repo.metadata.findRelationWithPropertyPath(
      nameOf<ProductSourceRecord>('product'),
    );
    if (!relation) throw new Error('ProductSourceRecord.product relation not found');
    return relation.inverseEntityMetadata.tableName;
  }
}

/** A ScrapedProduct key, type-checked. */
const key = (name: keyof ScrapedProduct): string => name;
/** A ScrapedOffer key, type-checked. */
const offerKey = (name: keyof ScrapedOffer): string => name;
/** The jsonb value when it is an object, else an empty one. */
const asObject = (value: string) =>
  `(CASE WHEN jsonb_typeof(${value}) = 'object' THEN ${value} ELSE '{}'::jsonb END)`;
/** The jsonb value when it is an array, else an empty one. */
const asArray = (value: string) =>
  `(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END)`;
