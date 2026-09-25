/**
 * Checks that a seller's sources give the same end state whichever runs first.
 *
 * One seller, `multisource-check`, with two feed sources over the same items:
 * - A: identifying, priority 60, fed from speedbike's Árukereső sample
 *   (`speedbike-feed-sample.xml`);
 * - G: `googleshop`, contributing (identifiesProducts off, post-process off),
 *   priority 40, read with the speedbike-googleshop config fixture from a
 *   Google Shopping TSV built from the same rows: its own, lower price, on
 *   sale on every other row (`sale_price`, with `price` the old price), and
 *   one row A does not have.
 *
 * Scenarios, each from a clean slate: A then G (then both again, which must
 * change nothing); G then A; both at once (the feed runs together, then A's
 * tasks in order while all of G's run beside them), three times. Each drains
 * the queued tasks through ProductImportTaskProcessorService.process, as the
 * scheduler would. The end
 * states — products by their listings, names, specs, offers field by field,
 * which listings wait unattached — must be identical, and each must hold:
 * - G created nothing: every product has an A listing, every offer an A row;
 * - every G listing sits on its offer's product, or waits when there is none;
 * - each offer's price is A's (priority 60), its old price G's when above it,
 *   and its sourceRecord A's listing;
 * - each product's description is its A listings' text, plain, or G's where A
 *   has none of 40 characters (an article number, say).
 *
 * An admin's description survives the next import of the product, and
 * clearing it brings the sources' text back.
 *
 * Then A lists the whole catalog (hasAllProducts): a complete run without one
 * row removes that offer and leaves G's listing of it waiting, which G's next
 * run does not undo; the row coming back restores the state before; a feed
 * missing more than the share guard allows removes nothing.
 *
 * DESTRUCTIVE on `fittkereso_e2e` only: it deletes the products holding the
 * two sources' listings, and its seller and sources at the end. It refuses
 * any database whose name does not end in `_e2e`.
 *
 * Nothing is fetched and no LLM is called: the feeds are served from the
 * fixture, and the identity extraction, unification, listing-match LLM,
 * embedding and image upload are stubbed.
 *
 * Usage (from fittkereso-backend/):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=<config pointing at a *_e2e database> \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/verify-multi-source.ts
 */
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { DataSource, In } from 'typeorm';
import {
  ProductImage,
  ProductImageRepository,
  ProductImportTaskRepository,
  ProductModel,
  ProductSource,
  ProductSourceRepository,
  ScrapedProduct,
  Seller,
  SellerRepository,
  SellerType,
  TaskStatus,
} from '@fittkereso-backend/database';
import {
  MIN_DESCRIPTION_LENGTH,
  ProductEmbeddingService,
  ProductImageCopyService,
  ProductUpdateService,
} from '@fittkereso-backend/product';
import { htmlToText } from '@fittkereso-backend/utils';
import {
  ArukeresoImportService,
  SpecPostProcessService,
} from '@fittkereso-backend/product-scraper';
import { ListingMatchLlmService } from '@fittkereso-backend/product-identity';
import { NativeScraperService } from '@fittkereso-backend/scraper';
import { AppModule } from '../src/app.module';
import { ProductImportTaskProcessorService } from '../src/modules/queue-processor/product-import-task/product-import-task-processor.service';

const SELLER_NAME = 'multisource-check';
const SOURCE_A = 'multisource-check-arukereso';
const SOURCE_G = 'multisource-check-google';
const FEED_A = 'https://multisource-check.test/arukereso.xml';
const FEED_G = 'https://multisource-check.test/google.tsv';
const G_ONLY_URL = 'https://speedbike.hu/multisource-check-google-only-bike';
const G_DESCRIPTION = 'Google description of the same bike, long enough to count.';
const FIXTURES = 'libs/product-scraper/src/lib/arukereso/__fixtures__';
const CONFIG_FIXTURE =
  'libs/scrape-interpreter/src/lib/interpreter/__fixtures__/speedbike-arukereso.config.json';
const GOOGLE_CONFIG_FIXTURE =
  'libs/scrape-interpreter/src/lib/interpreter/__fixtures__/speedbike-googleshop.config.json';
const CONCURRENT_REPETITIONS = 3;

type App = Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;

interface FeedRow {
  identifier: string;
  url: string;
  price: number;
  /** G's old price, when it has one. */
  oldPrice?: number;
  /** As the feed has it: HTML. */
  description?: string;
}

interface Feeds {
  a: string;
  g: string;
  /** What the stubbed fetch serves now: a removal scenario narrows A's. */
  served: { a: string; g: string };
  /** What each identifier's A and G rows say, and whether the category gate lets it in. */
  rows: Map<string, { a?: FeedRow; g?: FeedRow; eligible: boolean }>;
}

interface Snapshot {
  products: Record<
    string,
    { displayName: string; listings: string[]; specs: unknown; description: string | null }
  >;
  offers: Record<
    string,
    {
      product: string;
      price: number;
      priceWithoutDiscount: number | null;
      currency: string;
      availability: string | null;
      url: string | null;
      priceFrom: string | null;
    }
  >;
  unattached: string[];
}

let failures = 0;
const report = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function main(): Promise<void> {
  // Errors only: every row of a brand the database lacks warns, in every scenario.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const scheduler = app.get(SchedulerRegistry);
  for (const name of scheduler.getIntervals()) scheduler.deleteInterval(name);
  for (const [name] of scheduler.getCronJobs()) scheduler.deleteCronJob(name);
  for (const name of scheduler.getTimeouts()) scheduler.deleteTimeout(name);

  const db = app.get<DataSource>(getDataSourceToken('postgres'));
  const database = String(db.options.database);
  if (!database.endsWith('_e2e')) {
    await app.close();
    throw new Error(
      `Refusing to run against "${database}": this script deletes products. Point it at a *_e2e database.`,
    );
  }

  let sources: { a: ProductSource; g: ProductSource } | undefined;
  try {
    const feeds = buildFeeds();
    stubExternalCalls(app, feeds);
    await removeLeftovers(app, db);
    sources = await createSources(app);
    console.log(`${database}: seller ${SELLER_NAME}, ${feeds.rows.size} items`);

    const run = (source: ProductSource) => app.get(ArukeresoImportService).import(source);
    const baseline = await scenario(app, db, sources, 'A then G', async ({ a, g }) => {
      await run(a);
      await drain(app, [a]);
      await run(g);
      await drain(app, [g]);
    });
    checkEndState(baseline, feeds, 'A then G');

    // Unchanged rows are confirmed in place: G's waiting rows included, since
    // their offer still does not exist. A queues again only the rows it could
    // not import (a brand this database lacks), which have no listing.
    const aAgain = await run(sources.a);
    const gAgain = await run(sources.g);
    const aListings = Object.values(baseline.products).flatMap((product) =>
      product.listings.filter((listing) => listing.startsWith('A ')),
    ).length;
    const aEligible = [...feeds.rows.values()].filter((row) => row.a && row.eligible).length;
    report(
      aAgain.feedTasksEnqueued === aEligible - aListings && gAgain.feedTasksEnqueued === 0,
      'a second run of both queues only what A could not import',
      `A ${aAgain.feedTasksEnqueued} (expected ${aEligible - aListings}), G ${gAgain.feedTasksEnqueued}`,
    );
    report(
      gAgain.unattachedRecords === baseline.unattached.length,
      "G's second run reports its waiting listings",
      `${gAgain.unattachedRecords} of ${baseline.unattached.length}`,
    );
    compare(baseline, await snapshotOf(db, sources), 'a second run of both changes nothing');
    await adminDescriptionScenario(app, db, sources, baseline);

    const reversed = await scenario(app, db, sources, 'G then A', async ({ a, g }) => {
      await run(g);
      await drain(app, [g]);
      await run(a);
      await drain(app, [a]);
    });
    checkEndState(reversed, feeds, 'G then A');
    compare(baseline, reversed, 'G then A ends as A then G');

    for (let repetition = 1; repetition <= CONCURRENT_REPETITIONS; repetition++) {
      const label = `both at once #${repetition}`;
      const concurrent = await scenario(app, db, sources, label, async ({ a, g }) => {
        await Promise.all([run(a), run(g)]);
        await Promise.all([drain(app, [a]), drain(app, [g], { concurrently: true })]);
      });
      checkEndState(concurrent, feeds, label);
      compare(baseline, concurrent, `${label} ends as A then G`);
    }

    await removalScenarios(app, db, sources, feeds, baseline);
  } finally {
    if (sources) await wipe(db, sources);
    await removeLeftovers(app, db);
    await app.close();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  // Explicitly: a closed application context still leaves handles open.
  process.exit(failures === 0 ? 0 : 1);
}

/** A's feed is the fixture; G's, a Google Shopping TSV, is built from the same rows. */
function buildFeeds(): Feeds {
  const a = readFileSync(join(FIXTURES, 'speedbike-feed-sample.xml'), 'utf8');
  const rows: Feeds['rows'] = new Map();
  // Google's own columns, as speedbike's google_shopping feed has them.
  const gColumns = [
    'id', 'title', 'description', 'link', 'availability', 'price', 'sale_price',
    'brand', 'gtin', 'mpn', 'product_type',
  ] as const;
  const gRows: Record<(typeof gColumns)[number], string>[] = [];
  const field = (block: string, tag: string): string | undefined => {
    const match = block.match(
      new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`),
    );
    return match ? (match[1] ?? match[2] ?? '').trim() : undefined;
  };

  const blocks = a.match(/<product>[\s\S]*?<\/product>/g) ?? [];
  blocks.forEach((block, index) => {
    const identifier = field(block, 'identifier') as string;
    const url = field(block, 'product_url') as string;
    const price = Number(field(block, 'price'));
    const gPrice = price - 1000;
    // Every other row on sale at G, with its list price above A's price.
    const oldPrice = index % 2 === 0 ? Math.round(price * 1.25) : undefined;
    rows.set(identifier, {
      eligible: (field(block, 'category') ?? '').includes('> E-BIKE >'),
      a: { identifier, url, price, description: field(block, 'description') },
      g: { identifier, url, price: gPrice, oldPrice, description: G_DESCRIPTION },
    });
    gRows.push({
      id: identifier,
      title: `G ${field(block, 'name') ?? ''}`,
      description: G_DESCRIPTION,
      link: url,
      availability: 'in_stock',
      // On sale, Google's price is the list price and sale_price what it costs.
      price: `${oldPrice ?? gPrice} HUF`,
      sale_price: oldPrice === undefined ? '' : `${gPrice} HUF`,
      brand: field(block, 'manufacturer') ?? '',
      gtin: field(block, 'ean_code') ?? '',
      mpn: field(block, 'sku') ?? '',
      product_type: field(block, 'category') ?? '',
    });
  });
  rows.set('G-ONLY-1', {
    eligible: true,
    g: { identifier: 'G-ONLY-1', url: G_ONLY_URL, price: 500000 },
  });
  gRows.push({
    id: 'G-ONLY-1',
    title: 'CUBE only in Google',
    description: '',
    link: G_ONLY_URL,
    availability: 'in_stock',
    price: '500000 HUF',
    sale_price: '',
    brand: 'CUBE',
    gtin: '',
    mpn: '',
    product_type: 'Termékkategóriák > E-BIKE > MTB E-BIKE',
  });

  // Unquoted, as Google's is: a tab or line break inside a value would split it.
  const cell = (value: string) => value.replace(/[\t\r\n]+/g, ' ');
  const g = [gColumns.join('\t'), ...gRows.map((row) => gColumns.map((column) => cell(row[column])).join('\t'))]
    .join('\n')
    .concat('\n');
  return { a, g, served: { a, g }, rows };
}

/** A feed without the rows of these identifiers. */
function feedWithout(xml: string, identifiers: string[]): string {
  return xml.replace(/<product>[\s\S]*?<\/product>/g, (block) =>
    identifiers.some(
      (identifier) =>
        block.includes(`<identifier><![CDATA[${identifier}]]></identifier>`) ||
        block.includes(`<identifier>${identifier}</identifier>`),
    )
      ? ''
      : block,
  );
}

function stubExternalCalls(app: App, feeds: Feeds): void {
  (app.get(NativeScraperService) as unknown as {
    stream: (url: string) => Promise<unknown>;
  }).stream = async (url) => ({
    statusCode: 200,
    contentType: url === FEED_G ? 'text/tab-separated-values;charset=UTF-8' : 'application/xml',
    stream: Readable.from([url === FEED_G ? feeds.served.g : feeds.served.a]),
  });

  const specPostProcess = app.get(SpecPostProcessService) as unknown as {
    extractIdentity: (params: { scrapedProduct: ScrapedProduct }) => Promise<ScrapedProduct>;
    unify: (params: { scrapedProduct: ScrapedProduct }) => Promise<ScrapedProduct>;
  };
  specPostProcess.extractIdentity = async ({ scrapedProduct }) => scrapedProduct;
  specPostProcess.unify = async ({ scrapedProduct }) => scrapedProduct;

  // Declines, as a real call may: a new product.
  (app.get(ListingMatchLlmService) as unknown as {
    pick: () => Promise<{ reason: string }>;
  }).pick = async () => ({ reason: 'stubbed' });

  (app.get(ProductEmbeddingService) as unknown as {
    createProductEmbedding: () => Promise<number[]>;
  }).createProductEmbedding = async () => new Array(1536).fill(0.01);

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
          fileName: `multisource-check/${model.id}/${randomUUID()}.webp`,
          order: index,
        }),
      ),
    );
}

async function createSources(app: App): Promise<{ a: ProductSource; g: ProductSource }> {
  const sellerRepo = app.get(SellerRepository);
  const sourceRepo = app.get(ProductSourceRepository);
  const seller = await sellerRepo.save(
    Object.assign(new Seller(), { name: SELLER_NAME, type: SellerType.business }),
  );
  const fixture = (path: string) => {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    delete config.maxItems;
    return config;
  };

  const base = (name: string, type: ProductSource['type'], priority: number) =>
    Object.assign(new ProductSource(), {
      name,
      type,
      seller,
      priority,
      schedulingEnabled: false,
      processingEnabled: true,
    });
  const a = await sourceRepo.save(
    Object.assign(base(SOURCE_A, 'arukereso', 60), {
      identifiesProducts: true,
      config: { ...fixture(CONFIG_FIXTURE), feedUrl: FEED_A },
    }),
  );
  const g = await sourceRepo.save(
    Object.assign(base(SOURCE_G, 'googleshop', 40), {
      identifiesProducts: false,
      config: { ...fixture(GOOGLE_CONFIG_FIXTURE), feedUrl: FEED_G },
    }),
  );
  const load = (id: string) =>
    sourceRepo.findOneOrFail({ where: { id }, relations: { seller: true } });
  return { a: await load(a.id), g: await load(g.id) };
}

/**
 * A lists the whole catalog. A complete run without a row removes its offer
 * at once, and G's listing of it waits again — G's own next run does not
 * bring it back; the row coming back restores the state before. A feed
 * missing more than the share guard allows removes nothing.
 */
async function removalScenarios(
  app: App,
  db: DataSource,
  sources: { a: ProductSource; g: ProductSource },
  feeds: Feeds,
  baseline: Snapshot,
): Promise<void> {
  const run = (source: ProductSource) => app.get(ArukeresoImportService).import(source);
  const sourceRepo = app.get(ProductSourceRepository);
  await sourceRepo.repo.update(sources.a.id, { hasAllProducts: true });
  sources.a.hasAllProducts = true;
  try {
    const before = await scenario(app, db, sources, 'removal: A complete, then G', async ({ a, g }) => {
      await run(a);
      await drain(app, [a]);
      await run(g);
      await drain(app, [g]);
    });
    compare(baseline, before, 'removal: a complete source seeing every row ends as A then G');

    // An offer G also lists, so the removal has a listing to detach.
    const [removedKey, removedOffer] =
      Object.entries(before.offers).find(([, offer]) =>
        before.products[offer.product]?.listings.includes(`G ${offer.url}`),
      ) ?? [];
    if (!removedKey || !removedOffer) {
      report(false, 'removal: an offer G also lists');
      return;
    }

    feeds.served.a = feedWithout(feeds.a, [removedKey]);
    const removal = await run(sources.a);
    await drain(app, [sources.a]);
    const after = await snapshotOf(db, sources);
    report(
      removal.offersRemoved === 1 && removal.removalSkipped === undefined,
      'removal: a complete run without one row removes its offer',
      `${removedKey}: removed ${removal.offersRemoved}, skipped ${removal.removalSkipped ?? '—'}`,
    );
    report(!(removedKey in after.offers), 'removal: the offer is gone');
    report(
      after.unattached.includes(`G ${removedOffer.url}`),
      "removal: G's listing of it waits unattached again",
    );
    report(
      after.products[removedOffer.product]?.listings.includes(`A ${removedOffer.url}`) === true,
      "removal: A's own listing stays on its product",
    );

    const gAgain = await run(sources.g);
    await drain(app, [sources.g]);
    const afterG = await snapshotOf(db, sources);
    report(
      gAgain.feedTasksEnqueued === 0 &&
        !(removedKey in afterG.offers) &&
        afterG.unattached.includes(`G ${removedOffer.url}`),
      "removal: G's next run does not bring it back",
      `queued ${gAgain.feedTasksEnqueued}`,
    );

    feeds.served.a = feeds.a;
    await run(sources.a);
    await drain(app, [sources.a]);
    compare(before, await snapshotOf(db, sources), 'removal: the row coming back restores the state before');

    const missing = Object.keys(before.offers).slice(0, 3);
    feeds.served.a = feedWithout(feeds.a, missing);
    const truncated = await run(sources.a);
    await drain(app, [sources.a]);
    report(
      truncated.offersRemoved === 0 && truncated.removalSkipped === 'share_exceeded',
      `removal: a feed missing ${missing.length} of ${Object.keys(before.offers).length} offers removes nothing`,
      `removed ${truncated.offersRemoved}, skipped ${truncated.removalSkipped ?? '—'}`,
    );
    compare(before, await snapshotOf(db, sources), 'removal: the truncated feed left every offer');
  } finally {
    feeds.served.a = feeds.a;
    await sourceRepo.repo.update(sources.a.id, { hasAllProducts: false });
    sources.a.hasAllProducts = false;
  }
}

/**
 * An admin's description wins over the sources', survives the next import of
 * the product, and clearing it brings the sources' text back.
 */
async function adminDescriptionScenario(
  app: App,
  db: DataSource,
  sources: { a: ProductSource; g: ProductSource },
  baseline: Snapshot,
): Promise<void> {
  const [key, product] =
    Object.entries(baseline.products).find(([, candidate]) => candidate.description !== null) ?? [];
  if (!key || !product) {
    report(false, 'admin description: a product with a description');
    return;
  }
  const idOf = async (): Promise<string> => {
    const [row]: { modelId: string }[] = await db.query(
      `SELECT "modelId" FROM product_source_record WHERE "sourceId" = $1 AND url = $2`,
      [sources.a.id, key.split(' | ')[0].slice(2)],
    );
    return row.modelId;
  };
  const descriptionOf = async (): Promise<string | null> => {
    const [row]: { description: string | null }[] = await db.query(
      'SELECT description FROM product_model WHERE id = $1',
      [await idOf()],
    );
    return row.description;
  };
  // Its A rows import again: a changed hash is what queues a row.
  const reimport = async (): Promise<number> => {
    await db.query(
      `UPDATE product_source_record SET "feedRowHash" = NULL WHERE "modelId" = $1 AND "sourceId" = $2`,
      [await idOf(), sources.a.id],
    );
    const summary = await app.get(ArukeresoImportService).import(sources.a);
    await drain(app, [sources.a]);
    return summary.feedTasksEnqueued ?? 0;
  };
  const updates = app.get(ProductUpdateService);
  const adminText = 'Az admin leírása, ami minden forrásnál erősebb.';

  await updates.updateProduct(await idOf(), { description: adminText });
  report((await descriptionOf()) === adminText, "admin description: the admin's text is the product's");

  const queued = await reimport();
  report(
    queued > 0 && (await descriptionOf()) === adminText,
    'admin description: it survives the next import of the product',
    `${queued} rows imported again`,
  );

  await updates.updateProduct(await idOf(), { description: '' });
  report(
    (await descriptionOf()) === product.description,
    "admin description: clearing it brings the sources' text back",
  );
  const admins: { count: string }[] = await db.query(
    'SELECT count(*) FROM product_source_record WHERE "modelId" = $1 AND "sourceId" IS NULL',
    [await idOf()],
  );
  report(Number(admins[0].count) === 1, 'admin description: one admin record', admins[0].count);
}

/** One scenario from a clean slate, and the end state it leaves. */
async function scenario(
  app: App,
  db: DataSource,
  sources: { a: ProductSource; g: ProductSource },
  label: string,
  steps: (sources: { a: ProductSource; g: ProductSource }) => Promise<void>,
): Promise<Snapshot> {
  await wipe(db, sources);
  const started = Date.now();
  await steps(sources);
  const snapshot = await snapshotOf(db, sources);
  console.log(
    `\n== ${label} (${((Date.now() - started) / 1000).toFixed(1)} s): ` +
      `${Object.keys(snapshot.products).length} products, ${Object.keys(snapshot.offers).length} offers, ` +
      `${snapshot.unattached.length} unattached`,
  );
  return snapshot;
}

/**
 * Processes the sources' pending tasks, as the scheduler would: one after
 * another in URL order, or all at once.
 */
async function drain(
  app: App,
  sources: ProductSource[],
  options: { concurrently?: boolean } = {},
): Promise<void> {
  const taskRepo = app.get(ProductImportTaskRepository);
  const processor = app.get(ProductImportTaskProcessorService);
  const tasks = await taskRepo.find({
    where: { source: { id: In(sources.map((source) => source.id)) }, status: TaskStatus.PENDING },
    relations: { source: { seller: true } },
    order: { url: 'ASC' },
  });
  const one = async (task: (typeof tasks)[number]) => {
    try {
      await processor.process(task);
      await taskRepo.repo.update(task.id, { status: TaskStatus.DONE });
    } catch (error) {
      report(false, `task ${task.url}`, error instanceof Error ? error.message : String(error));
      await taskRepo.repo.update(task.id, { status: TaskStatus.FAILED });
    }
  };
  if (options.concurrently) {
    await Promise.all(tasks.map(one));
  } else {
    for (const task of tasks) await one(task);
  }
}

async function snapshotOf(
  db: DataSource,
  sources: { a: ProductSource; g: ProductSource },
): Promise<Snapshot> {
  const names = new Map([
    [sources.a.id, 'A'],
    [sources.g.id, 'G'],
  ]);
  const records: { id: string; sourceId: string; url: string; modelId: string | null }[] =
    await db.query(
      `SELECT id, "sourceId", url, "modelId" FROM product_source_record WHERE "sourceId" = ANY($1)`,
      [[sources.a.id, sources.g.id]],
    );
  const listingsOf = new Map<string, string[]>();
  for (const record of records) {
    if (!record.modelId) continue;
    const list = listingsOf.get(record.modelId) ?? [];
    list.push(`${names.get(record.sourceId)} ${record.url}`);
    listingsOf.set(record.modelId, list);
  }
  // A product is named by its A listings: ids differ between scenarios.
  const keyOf = new Map(
    [...listingsOf].map(([modelId, listings]) => [
      modelId,
      listings.filter((listing) => listing.startsWith('A ')).sort().join(' | ') ||
        `no A listing: ${listings.sort().join(' | ')}`,
    ]),
  );

  const products: Snapshot['products'] = {};
  const models: { id: string; displayName: string; specs: unknown; description: string | null }[] =
    await db.query(
      `SELECT id, "displayName", specs, description FROM product_model WHERE id = ANY($1)`,
      [[...listingsOf.keys()]],
    );
  for (const model of models) {
    products[keyOf.get(model.id) as string] = {
      displayName: model.displayName,
      listings: (listingsOf.get(model.id) ?? []).sort(),
      specs: model.specs,
      description: model.description,
    };
  }

  const offers: Snapshot['offers'] = {};
  const rows: {
    externalId: string;
    modelId: string;
    price: string;
    priceWithoutDiscount: string | null;
    currency: string;
    availability: string | null;
    url: string | null;
    priceSourceId: string | null;
  }[] = await db.query(
    `SELECT o."externalId", o."modelId", o.price, o."priceWithoutDiscount", o.currency,
            o.availability, o.url, r."sourceId" AS "priceSourceId"
       FROM offer o LEFT JOIN product_source_record r ON r.id = o."sourceRecordId"
      WHERE o."sellerId" = $1`,
    [sources.a.seller.id],
  );
  for (const row of rows) {
    offers[row.externalId] = {
      product: keyOf.get(row.modelId) ?? `unknown product ${row.modelId}`,
      price: Number(row.price),
      priceWithoutDiscount: row.priceWithoutDiscount === null ? null : Number(row.priceWithoutDiscount),
      currency: row.currency,
      availability: row.availability,
      url: row.url,
      priceFrom: row.priceSourceId ? (names.get(row.priceSourceId) ?? 'other') : null,
    };
  }

  return {
    products,
    offers,
    unattached: records
      .filter((record) => !record.modelId)
      .map((record) => `${names.get(record.sourceId)} ${record.url}`)
      .sort(),
  };
}

/** What every scenario must end with, whatever the order. */
function checkEndState(snapshot: Snapshot, feeds: Feeds, label: string): void {
  const productList = Object.entries(snapshot.products);
  const offerList = Object.entries(snapshot.offers);
  report(productList.length > 0, `${label}: products were created`, `${productList.length}`);

  const withoutA = productList.filter(([key]) => key.startsWith('no A listing'));
  report(withoutA.length === 0, `${label}: G created no product`, withoutA.map(([key]) => key).join(', '));

  const gRows = [...feeds.rows.values()].filter((row) => row.g && row.eligible).length;
  const gAttached = productList.flatMap(([, product]) =>
    product.listings.filter((listing) => listing.startsWith('G ')),
  );
  const gUnattached = snapshot.unattached.filter((listing) => listing.startsWith('G '));
  report(
    gAttached.length + gUnattached.length === gRows,
    `${label}: every G row is stored, attached or waiting`,
    `${gAttached.length} attached + ${gUnattached.length} waiting of ${gRows}`,
  );
  report(
    snapshot.unattached.every((listing) => listing.startsWith('G ')),
    `${label}: only G listings wait unattached`,
  );
  report(
    snapshot.unattached.includes(`G ${G_ONLY_URL}`),
    `${label}: the row only G has waits unattached`,
  );

  // A G listing waits exactly when its item has no offer.
  const offerUrls = new Set(offerList.map(([, offer]) => offer.url));
  const misplaced = gUnattached.filter((listing) => offerUrls.has(listing.slice(2)));
  report(misplaced.length === 0, `${label}: no G listing waits for an offer that exists`, misplaced.join(', '));
  const stranded = productList.flatMap(([key, product]) =>
    product.listings
      .filter((listing) => listing.startsWith('G '))
      .filter(
        (listing) =>
          !offerList.some(([, offer]) => offer.product === key && offer.url === listing.slice(2)),
      ),
  );
  report(stranded.length === 0, `${label}: every attached G listing sits with its offer`, stranded.join(', '));

  const wrong: string[] = [];
  for (const [externalId, offer] of offerList) {
    const row = feeds.rows.get(externalId);
    if (!row?.a) {
      wrong.push(`${externalId}: no A row`);
      continue;
    }
    const gOld = row.g?.oldPrice;
    const expectedOld = gOld !== undefined && gOld > row.a.price ? gOld : null;
    if (offer.price !== row.a.price) wrong.push(`${externalId}: price ${offer.price}, A says ${row.a.price}`);
    if (offer.priceWithoutDiscount !== expectedOld) {
      wrong.push(`${externalId}: old price ${offer.priceWithoutDiscount}, expected ${expectedOld}`);
    }
    if (offer.priceFrom !== 'A') wrong.push(`${externalId}: price from ${offer.priceFrom}`);
  }
  report(
    wrong.length === 0,
    `${label}: each offer has A's price, G's old price, A's listing as its source`,
    wrong.slice(0, 5).join('; '),
  );

  const described = { a: 0, g: 0, none: 0 };
  const wrongDescriptions: string[] = [];
  for (const [key, product] of productList) {
    const expected = expectedDescription(key, product, offerList, feeds);
    if (expected === null) described.none++;
    else if (expected === G_DESCRIPTION) described.g++;
    else described.a++;
    if (product.description !== expected) {
      wrongDescriptions.push(`${key}: ${JSON.stringify(product.description?.slice(0, 40))}`);
    }
  }
  report(
    wrongDescriptions.length === 0,
    `${label}: each product's description is A's plain text, else G's`,
    wrongDescriptions.length > 0
      ? wrongDescriptions.slice(0, 3).join('; ')
      : `${described.a} from A, ${described.g} from G, ${described.none} none`,
  );
}

/**
 * A's text beats G's (priority 60 over 40); among A's listings of one product
 * (its sizes), the longest text, then the lower URL. G's where A has no text
 * of MIN_DESCRIPTION_LENGTH and G lists the product.
 */
function expectedDescription(
  key: string,
  product: Snapshot['products'][string],
  offerList: [string, Snapshot['offers'][string]][],
  feeds: Feeds,
): string | null {
  const texts = offerList
    .filter(([, offer]) => offer.product === key)
    .flatMap(([externalId, offer]) => {
      const text = htmlToText(feeds.rows.get(externalId)?.a?.description ?? '');
      return text.length >= MIN_DESCRIPTION_LENGTH ? [{ url: offer.url ?? '', text }] : [];
    })
    .sort(
      (left, right) =>
        right.text.length - left.text.length ||
        byCodeUnit(left.url, right.url) ||
        byCodeUnit(left.text, right.text),
    );
  if (texts.length > 0) return texts[0].text;
  return product.listings.some((listing) => listing.startsWith('G ')) ? G_DESCRIPTION : null;
}

/** As lodash's orderBy compares strings. */
const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function compare(expected: Snapshot, actual: Snapshot, label: string): void {
  const differences: string[] = [];
  const keys = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys(expected.products, actual.products)) {
    if (JSON.stringify(expected.products[key]) !== JSON.stringify(actual.products[key])) {
      differences.push(`product ${key}`);
    }
  }
  for (const key of keys(expected.offers, actual.offers)) {
    if (JSON.stringify(expected.offers[key]) !== JSON.stringify(actual.offers[key])) {
      differences.push(
        `offer ${key}: ${JSON.stringify(expected.offers[key])} vs ${JSON.stringify(actual.offers[key])}`,
      );
    }
  }
  if (JSON.stringify(expected.unattached) !== JSON.stringify(actual.unattached)) {
    differences.push(`unattached: ${expected.unattached.length} vs ${actual.unattached.length}`);
  }
  report(differences.length === 0, label, differences.slice(0, 5).join('; '));
}

/** The products holding the sources' listings, the listings, and their tasks. */
async function wipe(db: DataSource, sources: { a: ProductSource; g: ProductSource }): Promise<void> {
  const ids = [sources.a.id, sources.g.id];
  const products: { id: string; embeddingId: string | null }[] = await db.query(
    `SELECT DISTINCT m.id, m."embeddingId" FROM product_model m
       JOIN product_source_record r ON r."modelId" = m.id WHERE r."sourceId" = ANY($1)`,
    [ids],
  );
  if (products.length > 0) {
    await db.query('DELETE FROM product_model WHERE id = ANY($1)', [products.map((p) => p.id)]);
    await db.query('DELETE FROM product_embedding WHERE id = ANY($1)', [
      products.map((p) => p.embeddingId).filter(Boolean),
    ]);
  }
  await db.query('DELETE FROM product_source_record WHERE "sourceId" = ANY($1)', [ids]);
  await db.query('DELETE FROM product_import_task WHERE "sourceId" = ANY($1)', [ids]);
  await db.query('DELETE FROM offer WHERE "sellerId" = $1', [sources.a.seller.id]);
}

/** Whatever an earlier, interrupted run left: its sources and seller. */
async function removeLeftovers(app: App, db: DataSource): Promise<void> {
  const sourceRepo = app.get(ProductSourceRepository);
  const leftovers = await sourceRepo.find({
    where: { name: In([SOURCE_A, SOURCE_G]) },
    relations: { seller: true },
  });
  const [a, g] = [SOURCE_A, SOURCE_G].map((name) =>
    leftovers.find((source) => source.name === name),
  );
  if (a && g) await wipe(db, { a, g });
  await db.query('DELETE FROM product_source_version WHERE "sourceId" = ANY($1)', [
    leftovers.map((source) => source.id),
  ]);
  await db.query('DELETE FROM product_source_action WHERE "sourceId" = ANY($1)', [
    leftovers.map((source) => source.id),
  ]);
  await db.query('DELETE FROM product_source WHERE name = ANY($1)', [[SOURCE_A, SOURCE_G]]);
  await db.query('DELETE FROM seller WHERE name = $1', [SELLER_NAME]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
