import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { In } from 'typeorm';
import { compact, isEmpty, keyBy, maxBy, uniq } from 'lodash';
import {
  CandidateMatchedOn,
  ProductAlias,
  ProductAliasRepository,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
  ProductSpecs,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import {
  CandidateRecallService,
  ProductMatchQuery,
  ProductMatchQueryService,
  RecallRow,
  trigramSimilarity,
} from '@fittkereso-backend/product-identity';
import { nameOf } from '@fittkereso-backend/utils';
import { AppModule } from '../app.module';

/**
 * The raw material for the labelled pair set: every case is a real query —
 * a listing replayed as if it were being scraped now, or a stored product
 * looking for duplicates — with the neighbourhood recall returns for it.
 * A person labels the cases afterwards; this script only reads.
 *
 * Keys come from the lib's own ProductMatchQueryService and recall from its
 * CandidateRecallService, so they are exactly what production computes; each
 * neighbour's trigram is measured against its listing key that is most like
 * the query's (trigramSimilarity, which matches pg_trgm).
 *
 * Run from the repo root:
 *   API_CONFIG_PATH=apps/api/src/config/config.yaml npx ts-node \
 *     --project apps/api/tsconfig.app.json -r tsconfig-paths/register \
 *     apps/api/src/scripts/export-identity-cases.ts
 */

const OUTPUT_PATH = '.scratch/identity-cases.raw.json';
const PRODUCT_PAGE_SIZE = 200;
/** How similar a neighbour must be for a product pair to be worth labelling. */
const PAIR_TRIGRAM_MIN = 0.6;

interface RawNeighbour {
  productId: string;
  matchedOn: CandidateMatchedOn;
  /** The neighbour's listing key most like the query's. */
  matchedValue: string;
  trigram: number;
  /** False for the attached product when recall didn't return it — a recall miss. */
  foundByRecall: boolean;
}

interface RawCase {
  kind: 'listing' | 'product';
  /** Source record id for a listing, product id for a product. */
  id: string;
  /** The product the listing sits on, or the product itself. */
  productId: string;
  sourceName?: string;
  createdAt?: string;
  brandName: string;
  categorySlug: string;
  /** The keys recall ran on: the listing's, or the product's listings'. */
  keys: string[];
  /** False when the keys come from a title (no model): they attach nothing. */
  keyed: boolean;
  displayName?: string;
  model?: string;
  specs?: ProductSpecs;
  neighbours: RawNeighbour[];
}

interface NeighbourDetail extends RawNeighbour {
  displayName?: string;
  model?: string;
  aliases: string[];
  specs?: ProductSpecs;
}

interface Services {
  queryService: ProductMatchQueryService;
  recall: CandidateRecallService;
  sourceRecordRepo: ProductSourceRecordRepository;
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const productRepo = app.get(ProductModelRepository);
  const aliasRepo = app.get(ProductAliasRepository);
  const services: Services = {
    queryService: app.get(ProductMatchQueryService),
    recall: app.get(CandidateRecallService),
    sourceRecordRepo: app.get(ProductSourceRecordRepository),
  };

  const cases: RawCase[] = [];
  let products = 0;
  let skipped = 0;

  for (let skip = 0; ; skip += PRODUCT_PAGE_SIZE) {
    const page = await productRepo.find({
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('sources'),
        `${nameOf<ProductModel>('sources')}.${nameOf<ProductSourceRecord>('source')}`,
      ],
      order: { id: 'ASC' },
      take: PRODUCT_PAGE_SIZE,
      skip,
    });
    if (isEmpty(page)) break;

    for (const product of page) {
      products++;
      try {
        cases.push(await productCase(product, services));
      } catch (error: unknown) {
        skipped++;
        console.warn(`  skip product ${product.id}: ${message(error)}`);
      }

      for (const record of listingRecordsOf(product)) {
        try {
          const listing = await listingCase(record, product, services);
          if (listing) cases.push(listing);
        } catch (error: unknown) {
          skipped++;
          console.warn(`  skip listing ${record.id}: ${message(error)}`);
        }
      }
    }
    console.log(`  Processed ${skip + page.length} products`);
  }

  const detailed = await withNeighbourDetails(cases, productRepo, aliasRepo);
  const listingCases = detailed.filter((entry) => entry.kind === 'listing');
  const recallMisses = listingCases.filter((entry) =>
    entry.neighbours.some(
      (neighbour) =>
        neighbour.productId === entry.productId && !neighbour.foundByRecall,
    ),
  );

  const payload = {
    exportedAt: new Date().toISOString(),
    summary: {
      products,
      listingCases: listingCases.length,
      productCases: detailed.length - listingCases.length,
      recallMisses: recallMisses.length,
      skipped,
      pairTrigramMin: PAIR_TRIGRAM_MIN,
    },
    cases: detailed,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));

  console.log(`\nWrote ${OUTPUT_PATH}`);
  console.log(`  products:      ${payload.summary.products}`);
  console.log(`  listing cases: ${payload.summary.listingCases}`);
  console.log(`  product cases: ${payload.summary.productCases}`);
  console.log(`  skipped:       ${payload.summary.skipped}`);
  console.log(
    `  recall misses: ${payload.summary.recallMisses} (listings whose own product recall did not return)`,
  );
  for (const miss of recallMisses) {
    console.log(`    ${miss.id} → ${miss.productId} (keys ${miss.keys.join(', ')})`);
  }

  await app.close();
  // The api context keeps handles open that would hold the script open after
  // its work is done (the same reason the other scripts here appear to hang).
  process.exit(0);
}

/**
 * Listings worth replaying: a product's second and later listings, which are
 * exactly the ones matching had to decide about. Its first listing created it,
 * so replaying that only asks whether a product matches itself.
 */
function listingRecordsOf(product: ProductModel): ProductSourceRecord[] {
  const sources = product.sources ?? [];
  if (sources.length < 2) return [];

  const createdAt = product.createdAt?.getTime() ?? 0;
  return sources.filter(
    (record) => (record.createdAt?.getTime() ?? 0) > createdAt,
  );
}

async function listingCase(
  record: ProductSourceRecord,
  product: ProductModel,
  services: Services,
): Promise<RawCase | undefined> {
  const scraped = record.scrapedProduct;
  // Manual rows carry specs only, and a listing with no name or title can't be
  // matched. One the extraction did not name is searched by its title.
  if (!scraped?.model && !scraped?.originalName) return undefined;

  const { productCategory } = product;
  const category = scraped.category ?? {
    id: productCategory?.id ?? '',
    slug: productCategory?.slug ?? '',
    name: productCategory?.name ?? '',
  };
  const query = services.queryService.ofListing(
    { ...scraped, category } as ScrapedProduct,
    product.brand,
  );
  const keys = query.keys ?? [];

  const neighbours = await neighboursOf(query, keys, services);
  // The product this listing ended up on is the answer we're labelling
  // against, so it belongs in every case — including when recall missed it.
  if (!neighbours.some((neighbour) => neighbour.productId === product.id)) {
    neighbours.push(await missedNeighbour(keys, product.id, services));
  }

  return {
    kind: 'listing',
    id: record.id,
    productId: product.id,
    sourceName: record.source?.name,
    createdAt: record.createdAt?.toISOString(),
    brandName: query.brandName,
    categorySlug: query.categorySlug,
    keys,
    keyed: query.keyed ?? false,
    displayName: scraped.displayName,
    model: scraped.model,
    specs: scraped.specs,
    neighbours,
  };
}

async function productCase(product: ProductModel, services: Services): Promise<RawCase> {
  const query = services.queryService.ofProduct(product);
  const stored =
    (await services.sourceRecordRepo.findNormalizedModelsByProductIds([product.id])).get(
      product.id,
    ) ?? [];
  const keys = isEmpty(stored)
    ? compact([services.queryService.keyOfName(product.model, query.brandName)])
    : stored;
  const neighbours = (await neighboursOf(query, keys, services)).filter(
    (neighbour) => neighbour.trigram >= PAIR_TRIGRAM_MIN,
  );

  return {
    kind: 'product',
    id: product.id,
    productId: product.id,
    createdAt: product.createdAt?.toISOString(),
    brandName: query.brandName,
    categorySlug: query.categorySlug,
    keys,
    keyed: !isEmpty(stored),
    displayName: product.displayName,
    model: product.model,
    specs: product.specs,
    neighbours,
  };
}

/** Every product recall returns for any of the keys, by its most similar listing key, most similar first. */
async function neighboursOf(
  query: ProductMatchQuery,
  keys: string[],
  services: Services,
): Promise<RawNeighbour[]> {
  const rows: RecallRow[] = (
    await Promise.all(keys.map((key) => services.recall.fuzzy(query, key)))
  ).flat();
  const scored = rows.map((row) => ({
    row,
    trigram: Math.max(...keys.map((key) => trigramSimilarity(key, row.normalizedModel))),
  }));

  const best = new Map<string, (typeof scored)[number]>();
  for (const entry of scored) {
    const current = best.get(entry.row.productId);
    if (!current || entry.trigram > current.trigram) best.set(entry.row.productId, entry);
  }

  return [...best.values()]
    .sort((a, b) => b.trigram - a.trigram)
    .map(({ row, trigram }) => ({
      productId: row.productId,
      matchedOn: keys.includes(row.normalizedModel) ? 'normalizedModel' : 'trigram',
      matchedValue: row.normalizedModel,
      trigram,
      foundByRecall: true,
    }));
}

/** How similar a product recall didn't return is, by its listing key most like the query's. */
async function missedNeighbour(
  keys: string[],
  productId: string,
  services: Services,
): Promise<RawNeighbour> {
  const own =
    (await services.sourceRecordRepo.findNormalizedModelsByProductIds([productId])).get(
      productId,
    ) ?? [];
  const best = maxBy(
    own.map((value) => ({
      value,
      trigram: Math.max(0, ...keys.map((key) => trigramSimilarity(key, value))),
    })),
    (entry) => entry.trigram,
  );

  return {
    productId,
    matchedOn: 'trigram',
    matchedValue: best?.value ?? '',
    trigram: best?.trigram ?? 0,
    foundByRecall: false,
  };
}

/** Fills in each neighbour's names, aliases and specs — two queries for the lot. */
async function withNeighbourDetails(
  cases: RawCase[],
  productRepo: ProductModelRepository,
  aliasRepo: ProductAliasRepository,
): Promise<(Omit<RawCase, 'neighbours'> & { neighbours: NeighbourDetail[] })[]> {
  const ids = uniq(
    cases.flatMap((entry) =>
      entry.neighbours.map((neighbour) => neighbour.productId),
    ),
  );
  if (isEmpty(ids)) {
    return cases.map((entry) => ({ ...entry, neighbours: [] }));
  }

  const products = keyBy(
    await productRepo.find({
      where: { id: In(ids) },
      select: {
        id: true,
        displayName: true,
        model: true,
        specs: true,
      },
    }),
    (product) => product.id,
  );
  const aliases = await aliasRepo.find({
    where: { model: { id: In(ids) } },
    relations: [nameOf<ProductAlias>('model')],
  });
  const aliasesByProduct = new Map<string, string[]>();
  for (const alias of aliases) {
    const list = aliasesByProduct.get(alias.model.id) ?? [];
    list.push(alias.alias);
    aliasesByProduct.set(alias.model.id, list);
  }

  return cases.map((entry) => ({
    ...entry,
    neighbours: entry.neighbours.map((neighbour) => {
      const product = products[neighbour.productId];
      return {
        ...neighbour,
        displayName: product?.displayName,
        model: product?.model,
        aliases: aliasesByProduct.get(neighbour.productId) ?? [],
        specs: product?.specs,
      };
    }),
  }));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

bootstrap().catch((error) => {
  console.error('Identity case export failed:', error);
  process.exit(1);
});
