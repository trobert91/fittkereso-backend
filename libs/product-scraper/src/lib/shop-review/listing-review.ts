import { isEqual } from 'lodash';
import {
  ProductSourceRecord,
  ProductSpecs,
  ScrapedOffer,
  ScrapedProductSpec,
} from '@fittkereso-backend/database';
import { SpecLabelReaders, SpecRowReader } from '@fittkereso-backend/product';
import { productDisplayName } from '@fittkereso-backend/utils';
import { ArukeresoFeedItem } from '../arukereso/arukereso-feed-item';
import { FeedFieldReaders } from '../arukereso/feed-fields-read-by';

/**
 * Where a listing's spec value came from:
 * - `d`: its deterministic mapping (extractedSpecs), kept by the LLM pass;
 * - `llm`: the LLM pass, with no deterministic value;
 * - `llm-changed`: the LLM pass replaced the deterministic value (`deterministic`).
 */
export type ListingSpecOrigin = 'd' | 'llm' | 'llm-changed';

export interface ReviewedListingSpec {
  key: string;
  value: ProductSpecs[string];
  origin: ListingSpecOrigin;
  deterministic?: ProductSpecs[string];
}

export interface ReviewedRawRow {
  /** `page`: from the feed listing's product page; `own`: the feed row's or the scraped page's own table. */
  origin: 'own' | 'page';
  name: string;
  sectionTitle?: string;
  values: string[];
  reader: SpecRowReader;
}

export interface ReviewedFeedField {
  name: string;
  value: string;
  readers: string[];
}

/** One listing next to what the source published for it. */
export interface ReviewedListing {
  recordId: string;
  url: string | null;
  externalId: string | null;
  title: string | null;
  model: string | null;
  flags: string[];
  specValid: boolean;
  category: string | null;
  product: {
    id: string;
    publicId: number;
    name: string;
    category: string | null;
    /** Keys only the product has: another seller's listing filled them. */
    otherSellers: { key: string; value: ProductSpecs[string] }[];
    /** Schema keys the product has no value for. */
    missingKeys: string[];
  } | null;
  /** The listing's own specs, each with where it came from. */
  specs: ReviewedListingSpec[];
  rawRows: ReviewedRawRow[];
  /** Feed sources: the top-level columns of the stored feed row, non-empty ones. */
  feedFields: ReviewedFeedField[] | null;
  description: string | null;
  descriptionLength: number;
  images: number;
  offers: ScrapedOffer[];
}

const FEED_FIELD_MAX = 200;

/**
 * A stored listing laid out for review: its specs by origin, every raw row
 * with how the config reads it, the stored feed row's columns, and what its
 * product has from other sellers or lacks. Pure: the caller loads the
 * record, its category's readers and schema, and its stored feed row.
 */
export function reviewListing(params: {
  record: ProductSourceRecord;
  readers: SpecLabelReaders;
  schemaKeys: string[];
  feedItem?: Pick<ArukeresoFeedItem, 'fields'> | null;
  feedReaders?: FeedFieldReaders | null;
  descriptionLimit: number;
}): ReviewedListing {
  const { record, readers } = params;
  const scraped = record.scrapedProduct ?? {};
  const specs = listingSpecs(scraped.extractedSpecs, scraped.specs);
  const product = record.product;
  const productSpecs = product?.specs ?? {};
  const own = new Set(specs.map((spec) => spec.key));
  const pageRows = scraped.page?.rawSpecs ?? [];
  const description = scraped.description?.trim() || null;

  return {
    recordId: record.id,
    url: record.url ?? null,
    externalId: record.externalId ?? null,
    title: scraped.originalName ?? record.originalTitle ?? null,
    model: scraped.model ?? record.model ?? null,
    flags: scraped.flags ?? [],
    specValid: record.specValid !== false,
    category: scraped.category?.slug ?? null,
    product: product
      ? {
          id: product.id,
          publicId: product.publicId,
          name: productDisplayName(product.brand?.name, product.model ?? ''),
          category: product.productCategory?.slug ?? null,
          otherSellers: Object.entries(productSpecs)
            .filter(([key, value]) => !own.has(key) && hasValue(value))
            .map(([key, value]) => ({ key, value })),
          missingKeys: params.schemaKeys.filter((key) => !hasValue(productSpecs[key])),
        }
      : null,
    specs,
    rawRows: (scraped.rawSpecs ?? []).map((row) => ({
      origin: pageRows.some((pageRow) => sameRow(pageRow, row)) ? 'page' : 'own',
      name: row.name,
      sectionTitle: row.sectionTitle,
      values: row.values ?? [],
      reader: readers.readerOf(row.name, row.sectionTitle),
    })),
    feedFields:
      params.feedItem && params.feedReaders
        ? Object.entries(params.feedItem.fields ?? {})
            .filter(([, value]) => String(value ?? '').trim() !== '')
            .map(([name, value]) => ({
              name,
              value: cut(String(value).trim(), FEED_FIELD_MAX),
              readers: params.feedReaders?.readersOf(name) ?? [],
            }))
        : null,
    description: description ? cut(description, params.descriptionLimit) : null,
    descriptionLength: description?.length ?? 0,
    images: scraped.images?.length ?? 0,
    offers: scraped.offers ?? [],
  };
}

/** The listing's specs after the LLM pass, each marked with where it came from. */
export function listingSpecs(
  extracted: ProductSpecs | undefined,
  merged: ProductSpecs | undefined,
): ReviewedListingSpec[] {
  const keys = new Set([...Object.keys(merged ?? {}), ...Object.keys(extracted ?? {})]);
  const result: ReviewedListingSpec[] = [];
  for (const key of keys) {
    const deterministic = extracted?.[key];
    const value = merged && key in merged ? merged[key] : deterministic;
    if (!hasValue(value)) continue;
    if (!hasValue(deterministic)) {
      result.push({ key, value, origin: 'llm' });
    } else if (isEqual(normalize(deterministic), normalize(value))) {
      result.push({ key, value, origin: 'd' });
    } else {
      result.push({ key, value, origin: 'llm-changed', deterministic });
    }
  }
  return result;
}

export function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function normalize(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (Array.isArray(value)) return value.map(normalize);
  return value;
}

function sameRow(a: ScrapedProductSpec, b: ScrapedProductSpec): boolean {
  return (
    a.name === b.name &&
    (a.sectionTitle ?? '') === (b.sectionTitle ?? '') &&
    isEqual(a.values ?? [], b.values ?? [])
  );
}

function cut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
