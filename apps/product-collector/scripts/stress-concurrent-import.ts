/**
 * Imports four listings of one new bike at the same time, over and over, and
 * checks what concurrent imports must never break.
 *
 * The listings are the KTM Macina Scarp SX EXONICX: speedbike's feed row and
 * ebikeshop's 43, 48 and 53 cm pages. ebikeshop's sizes declare each other as
 * siblings; its 48 cm page shares its GTIN with speedbike's row. Imported one
 * at a time, in any order, the three sizes always end on one product.
 * speedbike's row joins them, or — when it is created first and a 43 or 53 cm
 * page comes before the 48 — stays on its own product, paired with theirs by
 * the GTIN, because the two shops name the bike differently.
 *
 * Every repetition checks that concurrency changed none of that:
 * - the three ebikeshop sizes are on one product, and speedbike's row is on
 *   it or on a product paired with it;
 * - four listings and four offers, each offer on its listing's product;
 * - exactly one image per product — two listings attaching at once must not
 *   both copy one;
 * - no duplicate (product, alias) row, and no import failed.
 * Then two listings of different shops re-import concurrently onto the
 * existing product, and each must keep its own stored listing.
 *
 * `--no-locks` bypasses AdvisoryLockService, as a control: without the locks
 * the ebikeshop sizes race into several products, which is what shows the
 * check can fail.
 *
 * DESTRUCTIVE: before every repetition it deletes the products holding these
 * listings, with everything that cascades from them. It refuses any database
 * whose name does not end in `_e2e`.
 *
 * Nothing is fetched and no LLM is called. The listings are read once from
 * the database, as stored — already extracted — into a fixture file, and
 * reused from it; the identity extraction, unification, embedding and image
 * upload are stubbed.
 *
 * Usage (from fittkereso-backend/):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=<config pointing at a *_e2e database> \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/stress-concurrent-import.ts \
 *     [repetitions=10] [--no-locks] [--fixture=tmp/stress-exonicx-listings.json]
 */
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { DataSource, In } from 'typeorm';
import {
  AdvisoryLockService,
  ProductImage,
  ProductImageRepository,
  ProductModel,
  ProductSource,
  ProductSourceRecordRepository,
  ProductSourceRepository,
  ScrapedProduct,
} from '@fittkereso-backend/database';
import {
  ProductEmbeddingService,
  ProductImageCopyService,
} from '@fittkereso-backend/product';
import {
  ProductScrapeUpdaterService,
  SpecPostProcessService,
} from '@fittkereso-backend/product-scraper';
import { AppModule } from '../src/app.module';

const SPEEDBIKE_URL =
  'https://speedbike.hu/ktm-macina-scarp-sx-exonic-xx-t-type-l48-osszteleszkopos-elektromos-mtb-kerekpar-fresh-orange-szinben';
const EBIKESHOP_URLS = [
  'https://ebikeshop.hu/termek/ktm-macina-scarp-sx-exonicx-t-type-43cm-26-narancs-elektromos-kerekpar-18986',
  'https://ebikeshop.hu/termek/macina-scarp-sx-exonic-fresh-orange-dark-chrome-1x12a-srama-xxa-transmission-18097',
  'https://ebikeshop.hu/termek/ktm-macina-scarp-sx-exonicx-t-type-53cm-26-narancs-elektromos-kerekpar-18987',
];
const LISTING_URLS = [SPEEDBIKE_URL, ...EBIKESHOP_URLS];

interface FixtureListing {
  sourceName: string;
  url: string;
  scrapedProduct: ScrapedProduct;
}

interface Listing extends FixtureListing {
  source: ProductSource;
}

interface RepetitionResult {
  ok: boolean;
  summary: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repetitions = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 10);
  const withoutLocks = args.includes('--no-locks');
  const fixturePath =
    args.find((arg) => arg.startsWith('--fixture='))?.slice('--fixture='.length) ??
    'tmp/stress-exonicx-listings.json';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const scheduler = app.get(SchedulerRegistry);
  for (const name of scheduler.getIntervals()) scheduler.deleteInterval(name);
  for (const [name] of scheduler.getCronJobs()) scheduler.deleteCronJob(name);
  for (const name of scheduler.getTimeouts()) scheduler.deleteTimeout(name);

  try {
    const db = app.get<DataSource>(getDataSourceToken('postgres'));
    const database = String(db.options.database);
    if (!database.endsWith('_e2e')) {
      throw new Error(
        `Refusing to run against "${database}": this script deletes products. Point it at a *_e2e database.`,
      );
    }

    const listings = await loadListings(app, fixturePath);
    stubExternalCalls(app, withoutLocks);
    const updater = app.get(ProductScrapeUpdaterService);

    console.log(
      `${database}: ${repetitions} repetitions of 4 concurrent imports${withoutLocks ? ', LOCKS BYPASSED' : ''}`,
    );

    let failed = 0;
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      await deleteListingProducts(db);
      const settled = await Promise.allSettled(
        listings.map((listing) =>
          updater.createOrUpdateProduct(
            { source: listing.source, url: listing.url },
            structuredClone(listing.scrapedProduct),
          ),
        ),
      );
      const result = await checkRepetition(db, listings, settled);
      if (!result.ok) failed++;
      console.log(`${String(repetition).padStart(3)} ${result.ok ? 'ok  ' : 'FAIL'} ${result.summary}`);
    }

    const kept = await checkConcurrentReimports(db, updater, listings);
    console.log(`re-import onto one product: ${kept.ok ? 'ok  ' : 'FAIL'} ${kept.summary}`);

    console.log(
      failed === 0 && kept.ok
        ? 'All checks passed.'
        : `${failed} of ${repetitions} repetitions failed${kept.ok ? '' : ', and the re-import check failed'}.`,
    );
    process.exitCode = failed === 0 && kept.ok ? 0 : 1;
  } finally {
    await app.close();
  }
}

/** The four listings as stored, from the fixture, captured on first use. */
async function loadListings(
  app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>,
  fixturePath: string,
): Promise<Listing[]> {
  let fixture: FixtureListing[];
  if (existsSync(fixturePath)) {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } else {
    const records = await app.get(ProductSourceRecordRepository).find({
      where: { url: In(LISTING_URLS) },
      relations: ['source'],
    });
    fixture = LISTING_URLS.map((url) => {
      const record = records.find((candidate) => candidate.url === url);
      if (!record?.source || !record.scrapedProduct) {
        throw new Error(
          `No stored listing for ${url}. Import the four listings once (speedbike's feed row and the three ebikeshop pages), or pass --fixture.`,
        );
      }
      return {
        sourceName: record.source.name,
        url,
        scrapedProduct: record.scrapedProduct as ScrapedProduct,
      };
    });
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
    console.log(`Captured the four listings into ${fixturePath}`);
  }

  const sources = app.get(ProductSourceRepository);
  return Promise.all(
    fixture.map(async (listing) => ({
      ...listing,
      source: await sources.findOneOrFail({
        where: { name: listing.sourceName },
        relations: ['seller'],
      }),
    })),
  );
}

function stubExternalCalls(
  app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>,
  withoutLocks: boolean,
): void {
  // The stored listings are already extracted and unified.
  const specPostProcess = app.get(SpecPostProcessService) as unknown as {
    extractIdentity: (params: { scrapedProduct: ScrapedProduct }) => Promise<ScrapedProduct>;
    unify: (params: { scrapedProduct: ScrapedProduct }) => Promise<ScrapedProduct>;
  };
  specPostProcess.extractIdentity = async ({ scrapedProduct }) => scrapedProduct;
  specPostProcess.unify = async ({ scrapedProduct }) => scrapedProduct;

  (app.get(ProductEmbeddingService) as unknown as {
    createProductEmbedding: () => Promise<number[]>;
  }).createProductEmbedding = async () => new Array(1536).fill(0.01);

  // A row per image, as the real copy writes, without the upload.
  const imageRepo = app.get(ProductImageRepository);
  (app.get(ProductImageCopyService) as unknown as {
    copyImagesFromSource: (
      model: ProductModel,
      source: ProductSource,
      urls: string[],
    ) => Promise<ProductImage[]>;
  }).copyImagesFromSource = async (model, source, urls) =>
    imageRepo.saveAll(
      urls.map((url, index) =>
        Object.assign(new ProductImage(), {
          model,
          source,
          sourceUrl: url,
          fileName: `stress/${model.id}/${randomUUID()}.webp`,
          order: index,
        }),
      ),
    );

  if (withoutLocks) {
    (app.get(AdvisoryLockService) as unknown as {
      withLocks: (keys: unknown, work: () => Promise<unknown>) => Promise<unknown>;
    }).withLocks = async (_keys, work) => work();
  }
}

/** Every product holding one of the listings, with all that cascades from it. */
async function deleteListingProducts(db: DataSource): Promise<void> {
  const products: { id: string; embeddingId: string | null }[] = await db.query(
    `SELECT DISTINCT m.id, m."embeddingId"
       FROM product_model m
       JOIN product_source_record r ON r."modelId" = m.id
      WHERE r.url = ANY($1)`,
    [LISTING_URLS],
  );
  if (products.length === 0) return;
  await db.query('DELETE FROM product_model WHERE id = ANY($1)', [
    products.map((product) => product.id),
  ]);
  await db.query('DELETE FROM product_embedding WHERE id = ANY($1)', [
    products.map((product) => product.embeddingId).filter(Boolean),
  ]);
}

async function checkRepetition(
  db: DataSource,
  listings: Listing[],
  settled: PromiseSettledResult<unknown>[],
): Promise<RepetitionResult> {
  const problems: string[] = [];
  const failures = settled.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  for (const failure of failures) {
    problems.push(`import failed: ${String(failure.reason?.message ?? failure.reason).slice(0, 160)}`);
  }

  const records: { url: string; modelId: string }[] = await db.query(
    `SELECT url, "modelId" FROM product_source_record WHERE url = ANY($1)`,
    [LISTING_URLS],
  );
  const productOf = new Map(records.map((record) => [record.url, record.modelId]));
  if (records.length !== 4) problems.push(`${records.length} listings, expected 4`);

  const offers: { externalId: string; sellerId: string; modelId: string }[] = await db.query(
    `SELECT o."externalId", o."sellerId", o."modelId"
       FROM offer o
       JOIN product_source_record r ON r.id = o."sourceRecordId"
      WHERE r.url = ANY($1)`,
    [LISTING_URLS],
  );
  if (offers.length !== 4) problems.push(`${offers.length} offers, expected 4`);
  for (const listing of listings) {
    const offer = offers.find(
      (candidate) =>
        candidate.sellerId === listing.source.seller.id &&
        candidate.externalId === listing.scrapedProduct.offers?.[0]?.externalId,
    );
    if (offer && offer.modelId !== productOf.get(listing.url)) {
      problems.push(`${listing.url.slice(-20)}: offer and listing on different products`);
    }
  }

  const productIds = [...new Set(records.map((record) => record.modelId))];
  const ebikeshopProducts = new Set(EBIKESHOP_URLS.map((url) => productOf.get(url)));
  if (ebikeshopProducts.size !== 1) {
    problems.push(`ebikeshop's three sizes on ${ebikeshopProducts.size} products`);
  }
  const ebikeshopProduct = productOf.get(EBIKESHOP_URLS[1]);
  const speedbikeProduct = productOf.get(SPEEDBIKE_URL);
  let speedbikeJoined = speedbikeProduct === ebikeshopProduct;
  if (!speedbikeJoined && speedbikeProduct && ebikeshopProduct) {
    const pairs: unknown[] = await db.query(
      `SELECT 1 FROM product_duplicate_pair
        WHERE ("productAId" = $1 AND "productBId" = $2) OR ("productAId" = $2 AND "productBId" = $1)`,
      [speedbikeProduct, ebikeshopProduct],
    );
    if (pairs.length === 0) {
      problems.push("speedbike's row on a product neither ebikeshop's nor paired with it");
    }
    speedbikeJoined = false;
  }

  const images: { modelId: string; images: number }[] = await db.query(
    `SELECT m.id AS "modelId", COUNT(i.id)::int AS images
       FROM product_model m LEFT JOIN product_image i ON i."modelId" = m.id
      WHERE m.id = ANY($1) GROUP BY m.id`,
    [productIds],
  );
  for (const row of images) {
    if (row.images !== 1) problems.push(`a product with ${row.images} images`);
  }

  const duplicateAliases: unknown[] = await db.query(
    `SELECT 1 FROM product_alias WHERE "modelId" = ANY($1) GROUP BY "modelId", alias HAVING COUNT(*) > 1`,
    [productIds],
  );
  if (duplicateAliases.length > 0) problems.push(`${duplicateAliases.length} duplicate aliases`);

  const shape = `${productIds.length} product(s), speedbike ${speedbikeJoined ? 'joined' : 'paired'}`;
  return {
    ok: problems.length === 0,
    summary: problems.length === 0 ? shape : `${shape}: ${problems.join('; ')}`,
  };
}

/**
 * Two listings of different shops re-imported at once onto the product they
 * share, each with a changed name. A write that saved a copy of the product
 * loaded before the other's would put the other listing's old name back.
 */
async function checkConcurrentReimports(
  db: DataSource,
  updater: ProductScrapeUpdaterService,
  listings: Listing[],
): Promise<RepetitionResult> {
  // Sequentially, in the one order that always ends on one product: speedbike
  // creates it, the 48 cm page joins by GTIN, the other sizes as its siblings.
  await deleteListingProducts(db);
  const byUrl = (url: string): Listing => {
    const listing = listings.find((candidate) => candidate.url === url);
    if (!listing) throw new Error(`No listing for ${url}`);
    return listing;
  };
  for (const listing of [SPEEDBIKE_URL, EBIKESHOP_URLS[1], EBIKESHOP_URLS[0], EBIKESHOP_URLS[2]].map(byUrl)) {
    await updater.createOrUpdateProduct(
      { source: listing.source, url: listing.url },
      structuredClone(listing.scrapedProduct),
    );
  }

  const pair = [byUrl(SPEEDBIKE_URL), byUrl(EBIKESHOP_URLS[1])];
  const problems: string[] = [];
  for (let round = 1; round <= 5; round++) {
    const marked = pair.map((listing, index) => {
      const scrapedProduct = structuredClone(listing.scrapedProduct);
      scrapedProduct.displayName = `${scrapedProduct.displayName} [${index === 0 ? 'A' : 'B'}${round}]`;
      return { listing, scrapedProduct };
    });
    await Promise.all(
      marked.map(({ listing, scrapedProduct }) =>
        updater.createOrUpdateProduct({ source: listing.source, url: listing.url }, scrapedProduct),
      ),
    );
    const stored: { url: string; displayName: string }[] = await db.query(
      `SELECT url, "scrapedProduct"->>'displayName' AS "displayName"
         FROM product_source_record WHERE url = ANY($1)`,
      [pair.map((listing) => listing.url)],
    );
    for (const { listing, scrapedProduct } of marked) {
      const row = stored.find((candidate) => candidate.url === listing.url);
      if (row?.displayName !== scrapedProduct.displayName) {
        problems.push(`round ${round}: ${listing.sourceName} holds "${row?.displayName}"`);
      }
    }
  }
  return {
    ok: problems.length === 0,
    summary: problems.length === 0 ? '5 rounds, both listings kept' : problems.join('; '),
  };
}

// Explicit exits: the app context leaves handles open after close.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
