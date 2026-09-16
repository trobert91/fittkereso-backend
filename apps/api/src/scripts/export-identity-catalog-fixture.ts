import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { compact, isEmpty, sortBy, uniq } from 'lodash';
import {
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSpecs,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import { ProductMatchQueryService } from '@fittkereso-backend/product-identity';
import { nameOf } from '@fittkereso-backend/utils';
import { AppModule } from '../app.module';

/**
 * Freezes a scraped catalog into the single fixture the product-identity specs
 * run against. Every value here is real: the products and listings are rows,
 * the name keys come from ProductMatchQueryService (the rule production uses —
 * the stored `normalizedSourceName` column is never read, two different rules
 * wrote it), and every trigram is Postgres' own `similarity()`.
 *
 * Listings are the point. A product's specs are already merged from all its
 * shops, so product-to-product pairs can only ever show what the old matcher
 * settled on. A listing is one shop's unmerged view of one bike, so replaying
 * it asks the question that matters: would speedbike's rendering of a bike find
 * ebikeshop's, and would it wrongly find something else?
 *
 * Run from the repo root:
 *   API_CONFIG_PATH=apps/api/src/config/config.yaml npx ts-node \
 *     --project apps/api/tsconfig.app.json -r tsconfig-paths/register \
 *     apps/api/src/scripts/export-identity-catalog-fixture.ts
 */

const OUTPUT_PATH = 'libs/product-identity/src/lib/testing/catalog.json';
const PAGE_SIZE = 200;

interface FixtureProduct {
  id: string;
  displayName: string;
  model: string | null;
  brand: string;
  categorySlug: string;
  nameKey: string;
  specs?: ProductSpecs;
  listings: number;
  sources: string[];
}

interface FixtureListing {
  id: string;
  /** The shop's ProductSource name: "speedbike" or "ebikeshop". */
  shop: string;
  url?: string;
  /** Built by ProductMatchQueryService.ofListing, exactly as a scrape would. */
  nameKey: string;
  brand: string;
  model?: string;
  displayName?: string;
  /** The shop's raw title, before post-processing stripped it down to `model`. */
  originalName?: string;
  specs?: ProductSpecs;
  /** The product this listing was actually attached to. */
  productId: string;
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const productRepo = app.get(ProductModelRepository);
  const queryService = app.get(ProductMatchQueryService);

  const products: FixtureProduct[] = [];
  const listings: FixtureListing[] = [];
  let skippedProducts = 0;
  let skippedListings = 0;

  for (let skip = 0; ; skip += PAGE_SIZE) {
    const page = await productRepo.find({
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('sources'),
        `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}`,
      ],
      order: { id: 'ASC' },
      take: PAGE_SIZE,
      skip,
    });
    if (isEmpty(page)) break;

    for (const product of page) {
      const records = product.sources ?? [];
      const shops = uniq(compact(records.map((record) => record.source?.name)));

      try {
        products.push({
          id: product.id,
          displayName: product.displayName,
          model: product.model ?? null,
          brand: product.brand.name,
          categorySlug: product.productCategory.slug,
          nameKey: queryService.ofProduct(product).nameKey,
          specs: specsOrUndefined(product.specs),
          listings: records.length,
          sources: shops.sort(),
        });
      } catch (error: unknown) {
        skippedProducts++;
        console.warn(`  skip product ${product.id}: ${message(error)}`);
        continue;
      }

      for (const record of records) {
        const listing = listingOf(record, product, queryService);
        if (listing) listings.push(listing);
        else skippedListings++;
      }
    }
    console.log(`  Processed ${skip + page.length} products`);
  }

  const trigrams = await trigramMatrix(
    uniq([
      ...products.map((product) => product.nameKey),
      ...listings.map((listing) => listing.nameKey),
    ]),
    productRepo,
  );

  const payload = {
    exportedAt: new Date().toISOString(),
    products: sortBy(products, (product) => product.nameKey),
    listings: sortBy(listings, [
      (listing) => listing.shop,
      (listing) => listing.nameKey,
      (listing) => listing.id,
    ]),
    trigrams,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);

  const shops = uniq(listings.map((listing) => listing.shop)).sort();
  console.log(`\nWrote ${OUTPUT_PATH}`);
  console.log(`  products:    ${products.length}`);
  console.log(`  listings:    ${listings.length} across ${shops.join(', ')}`);
  console.log(`  name keys:   ${uniq(listings.map((l) => l.nameKey)).length} distinct (listings)`);
  console.log(`  trigrams:    ${trigrams.length} key pairs with similarity > 0`);
  if (skippedProducts || skippedListings) {
    console.log(
      `  skipped:     ${skippedProducts} products, ${skippedListings} listings`,
    );
  }

  await app.close();
  // The api context keeps handles open that would hold the script open after
  // its work is done (the same reason the other scripts here appear to hang).
  process.exit(0);
}

/**
 * One listing, keyed the way a scrape of it would be. `category` falls back to
 * the product's: manual and older rows don't always carry one, and ofListing
 * needs it to pick the category's normalization strategy.
 */
function listingOf(
  record: ProductSourceRecord,
  product: ProductModel,
  queryService: ProductMatchQueryService,
): FixtureListing | undefined {
  const scraped = record.scrapedProduct;
  if (!scraped?.model && !scraped?.displayName) return undefined;

  const { productCategory } = product;
  const category = scraped.category ?? {
    id: productCategory.id,
    slug: productCategory.slug,
    name: productCategory.name,
  };

  return {
    id: record.id,
    shop: record.source?.name ?? 'unknown',
    url: record.url ?? undefined,
    nameKey: queryService.ofListing(
      { ...scraped, category } as ScrapedProduct,
      product.brand,
    ).nameKey,
    brand: scraped.brand ?? product.brand.name,
    model: scraped.model,
    displayName: scraped.displayName,
    originalName: scraped.originalName,
    specs: specsOrUndefined(scraped.specs),
    productId: product.id,
  };
}

/**
 * Postgres' `similarity()` for every pair of keys that scores above zero, so a
 * test can apply the real recall threshold itself. Identical keys are left out
 * — they are similarity 1 by definition, and the pair list holds each pair once.
 */
async function trigramMatrix(
  keys: string[],
  productRepo: ProductModelRepository,
): Promise<[string, string, number][]> {
  const rows: { a: string; b: string; trigram: number | string }[] =
    await productRepo.repo.query(
      `WITH keys AS (SELECT DISTINCT unnest($1::text[]) AS k)
       SELECT a.k AS a, b.k AS b, similarity(a.k, b.k) AS trigram
       FROM keys a JOIN keys b ON a.k < b.k
       WHERE similarity(a.k, b.k) > 0
       ORDER BY a.k, b.k`,
      [keys],
    );

  return rows.map((row) => [row.a, row.b, Number(row.trigram)]);
}

/** An empty spec bag is no specs at all — and one catalog product really has none. */
function specsOrUndefined(specs?: ProductSpecs): ProductSpecs | undefined {
  return isEmpty(specs) ? undefined : specs;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

bootstrap().catch((error) => {
  console.error('Identity catalog fixture export failed:', error);
  process.exit(1);
});
