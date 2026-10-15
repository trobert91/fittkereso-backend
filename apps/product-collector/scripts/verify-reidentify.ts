/**
 * Checks re-identification on a real database: a feed listing whose identity
 * key changed so that its product no longer fits it is identified again, and
 * moved with its offer.
 *
 * Three sellers, each with an identifying Árukereső source: A (the listings
 * that change), B (the other shop whose listings make the products), and A2
 * (A's second source, for the blocked case). The listings are KTM
 * "Zebrafly" bikes, written straight through ProductScrapeUpdaterService as a
 * feed import would; each scenario starts from a clean slate:
 * - fits: a battery its product agrees with keeps the listing there;
 * - move: a battery its product contradicts moves it onto the product that
 *   has it, with its offer (same id) and its price history; the product it
 *   left keeps its other listing and is priced again; a re-import changes
 *   nothing;
 * - split: a battery no product has moves it onto a new product;
 * - merge: a listing alone on its product, gaining another product's MPN,
 *   takes its product along — the two are merged;
 * - shadow then on: shadow mode keeps it put and marks it pending, keeping
 *   the key decided before; on, the same import moves it and clears the mark;
 * - pinned, blocked, off: it stays.
 *
 * DESTRUCTIVE on `fittkereso_e2e` only: it deletes the products holding its
 * sources' listings, and its sellers and sources at the end. It refuses any
 * database whose name does not end in `_e2e`.
 *
 * Nothing is fetched and no LLM is called: the identity extraction,
 * unification, listing-match LLM, embedding and image upload are stubbed.
 * Needs the KTM brand and the ebikes category in the database.
 *
 * Usage (from fittkereso-backend/):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=<config pointing at a *_e2e database> \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/verify-reidentify.ts
 */
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { getDataSourceToken } from '@nestjs/typeorm';
import { readFileSync } from 'fs';
import { DataSource } from 'typeorm';
import {
  OfferAvailability,
  OfferCondition,
  PriceHistory,
  PriceHistoryRepository,
  ProductSource,
  ProductSourceRepository,
  ProductSpecs,
  ScrapedProduct,
  Seller,
  SellerRepository,
  SellerType,
} from '@fittkereso-backend/database';
import type { ReidentifyMode } from '@fittkereso-backend/dynamic-config';
import { ProductEmbeddingService, ProductImageCopyService } from '@fittkereso-backend/product';
import {
  ListingReidentificationService,
  ProductScrapeUpdaterService,
  SpecPostProcessService,
} from '@fittkereso-backend/product-scraper';
import { ListingMatchLlmService } from '@fittkereso-backend/product-identity';
import { AppModule } from '../src/app.module';

const PREFIX = 'reidentify-check';
const SELLERS = { a: `${PREFIX}-a`, b: `${PREFIX}-b` };
const SOURCES = { a: `${PREFIX}-a`, a2: `${PREFIX}-a2`, b: `${PREFIX}-b` };
const CONFIG_FIXTURE =
  'libs/scrape-interpreter/src/lib/interpreter/__fixtures__/speedbike-arukereso.config.json';
const TOUR = 'Zebrafly Tour 610';

type App = Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
type Sources = Record<keyof typeof SOURCES, ProductSource>;

interface Listing {
  id: string;
  model?: string;
  specs?: ProductSpecs;
  mpn?: string;
  price?: number;
}

let failures = 0;
const report = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

let mode: ReidentifyMode = 'on';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
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

  let sources: Sources | undefined;
  try {
    stubExternalCalls(app);
    await removeLeftovers(db);
    sources = await createSources(app);
    const [category] = await db.query(
      `SELECT id, slug, name FROM product_category WHERE slug = 'ebikes'`,
    );
    if (!category) throw new Error('No ebikes category in this database');
    const ctx = new Checks(app, db, sources, category);
    console.log(`${database}: sellers ${SELLERS.a}, ${SELLERS.b}`);

    await ctx.scenario('fits', async () => {
      const x = await ctx.tourWithA();
      await ctx.importA({ id: 'a1', specs: { modelYear: 2026, batteryCapacity: 625 } });
      report((await ctx.productOf('a', 'a1')) === x, 'a battery its product agrees with keeps it there');
      const key = await ctx.keyOf('a', 'a1');
      report(key?.specs?.batteryCapacity === 625, 'the key now is kept', JSON.stringify(key?.specs));
    });

    await ctx.scenario('move', async () => {
      const x = await ctx.tourWithA();
      const z = await ctx.importB({ id: 'b2', specs: { modelYear: 2026, batteryCapacity: 750 }, price: 990 });
      report(z !== x, 'B’s 750 Wh bike is a product of its own');
      const offer = await ctx.offerOf('a', 'a1');
      await ctx.addPriceHistory(offer.id, x);

      await ctx.importA({ id: 'a1', specs: { modelYear: 2026, batteryCapacity: 750 }, price: 980 });

      report((await ctx.productOf('a', 'a1')) === z, 'a battery its product contradicts moves it onto the one that has it');
      const moved = await ctx.offerOf('a', 'a1');
      report(moved.id === offer.id && moved.modelId === z, 'its offer moves with it, keeping its id', JSON.stringify(moved));
      report((await ctx.priceHistoryModels(offer.id)).every((id) => id === z), 'its price history moves with its offer');
      report((await ctx.productOf('b', 'b1')) === x, 'the product it left keeps its other listing');
      const prices = await ctx.prices([x, z]);
      report(prices[x] === 1000 && prices[z] === 980, 'both products are priced again', JSON.stringify(prices));

      await ctx.importA({ id: 'a1', specs: { modelYear: 2026, batteryCapacity: 750 }, price: 980 });
      report((await ctx.productOf('a', 'a1')) === z, 'importing it again changes nothing');
    });

    await ctx.scenario('split', async () => {
      const x = await ctx.tourWithA();
      const offer = await ctx.offerOf('a', 'a1');

      await ctx.importA({ id: 'a1', specs: { modelYear: 2026, batteryCapacity: 500 } });

      const n = await ctx.productOf('a', 'a1');
      report(!!n && n !== x, 'a battery no product has splits it onto a new product');
      report((await ctx.listingsOf(n)).join() === 'a:a1', 'the new product holds it alone');
      report((await ctx.offerOf('a', 'a1')).id === offer.id, 'its offer keeps its id');
      report((await ctx.listingsOf(x)).join() === 'b:b1', 'the product it left keeps its other listing');
    });

    await ctx.scenario('merge', async () => {
      const w = await ctx.importB({ id: 'b3', model: 'Zebrafly Sport 720', specs: { modelYear: 2026 }, mpn: 'ZF720MPN' });
      const y = await ctx.importA({ id: 'a3', model: 'Zebrafly Sport 720 Plus', specs: { modelYear: 2026 } });
      report(y !== w, 'the two start as two products');
      const offer = await ctx.offerOf('a', 'a3');

      await ctx.importA({ id: 'a3', model: 'Zebrafly Sport 720 Plus', specs: { modelYear: 2026 }, mpn: 'ZF720MPN' });

      report((await ctx.productOf('a', 'a3')) === w, 'gaining another product’s MPN moves it there');
      report(!(await ctx.exists(y)), 'the product it alone identified is merged away');
      report((await ctx.offerOf('a', 'a3')).id === offer.id, 'its offer keeps its id');
    });

    await ctx.scenario('shadow, then on', async () => {
      mode = 'shadow';
      const x = await ctx.tourWithA();
      const z = await ctx.importB({ id: 'b2', specs: { modelYear: 2026, batteryCapacity: 750 } });

      await ctx.importA({ id: 'a1', specs: { modelYear: 2026, batteryCapacity: 750 } });

      report((await ctx.productOf('a', 'a1')) === x, 'shadow mode keeps it put');
      report((await ctx.pending('a', 'a1')) === true, 'and marks it pending');
      const key = await ctx.keyOf('a', 'a1');
      report(key?.specs?.batteryCapacity === undefined, 'keeping the key decided before', JSON.stringify(key?.specs));

      mode = 'on';
      await ctx.importA({ id: 'a1', specs: { modelYear: 2026, batteryCapacity: 750 } });
      report((await ctx.productOf('a', 'a1')) === z, 'on, the same import moves it');
      report((await ctx.pending('a', 'a1')) === false, 'and clears the mark');
    });

    await ctx.scenario('pinned', async () => {
      const x = await ctx.tourWithA();
      await ctx.importB({ id: 'b2', specs: { modelYear: 2026, batteryCapacity: 750 } });
      await db.query(
        `UPDATE product_source_record SET "identityPinned" = true WHERE "sourceId" = $1 AND "externalId" = 'a1'`,
        [sources.a.id],
      );

      await ctx.importA({ id: 'a1', specs: { modelYear: 2026, batteryCapacity: 750 } });

      report((await ctx.productOf('a', 'a1')) === x, 'a pinned listing stays');
    });

    await ctx.scenario('blocked', async () => {
      const x = await ctx.tourWithA();
      await ctx.importB({ id: 'b2', specs: { modelYear: 2026, batteryCapacity: 750 } });
      // A's second source lists the same offer, and joins its product.
      await ctx.importAs('a2', { id: 'a1' });
      report((await ctx.productOf('a2', 'a1')) === x, 'A’s second source joins the same product');

      await ctx.importA({ id: 'a1', specs: { modelYear: 2026, batteryCapacity: 750 } });

      report((await ctx.productOf('a', 'a1')) === x, 'a listing whose offer another source of its seller carries stays');
    });

    await ctx.scenario('off', async () => {
      mode = 'off';
      const x = await ctx.tourWithA();
      await ctx.importB({ id: 'b2', specs: { modelYear: 2026, batteryCapacity: 750 } });

      await ctx.importA({ id: 'a1', specs: { modelYear: 2026, batteryCapacity: 750 } });

      report((await ctx.productOf('a', 'a1')) === x, 'mode off moves nothing');
      report((await ctx.keyOf('a', 'a1')) === undefined, 'and keeps no key');
      mode = 'on';
    });
  } finally {
    if (sources) await wipe(db, sources);
    await removeLeftovers(db);
    await app.close();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

class Checks {
  constructor(
    private readonly app: App,
    private readonly db: DataSource,
    private readonly sources: Sources,
    private readonly category: { id: string; slug: string; name: string },
  ) {}

  async scenario(label: string, steps: () => Promise<void>): Promise<void> {
    mode = 'on';
    await wipe(this.db, this.sources);
    console.log(`\n== ${label}`);
    try {
      await steps();
    } catch (error) {
      report(false, `${label} threw`, error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }

  /**
   * The Tour, X: A's listing a1 with no battery, then B's b1 with 625 Wh,
   * which joins it.
   */
  async tourWithA(): Promise<string> {
    const x = await this.importA({ id: 'a1', specs: { modelYear: 2026 } });
    const joined = await this.importB({ id: 'b1', specs: { modelYear: 2026, batteryCapacity: 625 }, price: 1000 });
    report(joined === x, 'B’s 625 Wh listing joins A’s Tour');
    return x;
  }

  importA(listing: Listing): Promise<string> {
    return this.importAs('a', listing);
  }

  importB(listing: Listing): Promise<string> {
    return this.importAs('b', listing);
  }

  async importAs(source: keyof Sources, listing: Listing): Promise<string> {
    const url = `https://${PREFIX}.test/${source}/${listing.id}`;
    const scraped = {
      category: this.category,
      brand: 'KTM',
      model: listing.model ?? TOUR,
      originalName: `KTM ${listing.model ?? TOUR}`,
      externalId: listing.id,
      specs: listing.specs ?? { modelYear: 2026 },
      extractedSpecs: listing.specs ?? { modelYear: 2026 },
      images: [],
      offers: [
        {
          externalId: listing.id,
          price: listing.price ?? 1100,
          currency: 'HUF',
          availability: OfferAvailability.in_stock,
          url,
          ...(listing.mpn ? { mpn: listing.mpn } : {}),
        },
      ],
    } as unknown as ScrapedProduct;
    const model = await this.app
      .get(ProductScrapeUpdaterService)
      .createOrUpdateProduct({ source: this.sources[source], url }, scraped);
    if (!model) throw new Error(`${source} ${listing.id} was not written`);
    return model.id;
  }

  async productOf(source: keyof Sources, externalId: string): Promise<string | undefined> {
    const [row] = await this.db.query(
      `SELECT "productId" FROM product_source_record WHERE "sourceId" = $1 AND "externalId" = $2`,
      [this.sources[source].id, externalId],
    );
    return row?.productId ?? undefined;
  }

  async keyOf(source: keyof Sources, externalId: string): Promise<{ specs?: ProductSpecs } | undefined> {
    const [row] = await this.db.query(
      `SELECT "scrapedProduct"->'identityKey' AS key FROM product_source_record WHERE "sourceId" = $1 AND "externalId" = $2`,
      [this.sources[source].id, externalId],
    );
    return row?.key ?? undefined;
  }

  async pending(source: keyof Sources, externalId: string): Promise<boolean> {
    const [row] = await this.db.query(
      `SELECT "reidentifyPending" FROM product_source_record WHERE "sourceId" = $1 AND "externalId" = $2`,
      [this.sources[source].id, externalId],
    );
    return row?.reidentifyPending;
  }

  async offerOf(source: keyof Sources, externalId: string): Promise<{ id: string; modelId: string }> {
    const [row] = await this.db.query(
      `SELECT id, "modelId" FROM offer WHERE "sellerId" = $1 AND "externalId" = $2`,
      [this.sources[source].seller.id, externalId],
    );
    return row;
  }

  async listingsOf(productId: string | undefined): Promise<string[]> {
    const names = new Map(Object.entries(this.sources).map(([name, source]) => [source.id, name]));
    const rows: { sourceId: string; externalId: string }[] = await this.db.query(
      `SELECT "sourceId", "externalId" FROM product_source_record WHERE "productId" = $1`,
      [productId],
    );
    return rows.map((row) => `${names.get(row.sourceId) ?? '?'}:${row.externalId}`).sort();
  }

  async prices(ids: string[]): Promise<Record<string, number | null>> {
    const rows: { id: string; price: string | null }[] = await this.db.query(
      'SELECT id, price FROM product_model WHERE id = ANY($1)',
      [ids],
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.price === null ? null : Number(row.price)]));
  }

  async exists(productId: string | undefined): Promise<boolean> {
    const [row] = await this.db.query('SELECT 1 FROM product_model WHERE id = $1', [productId]);
    return !!row;
  }

  async addPriceHistory(offerId: string, modelId: string): Promise<void> {
    await this.app.get(PriceHistoryRepository).save(
      Object.assign(new PriceHistory(), {
        model: { id: modelId },
        offer: { id: offerId },
        condition: OfferCondition.new,
        price: 1100,
        currency: 'HUF',
        observedAt: new Date(),
      }),
    );
  }

  async priceHistoryModels(offerId: string): Promise<string[]> {
    const rows: { modelId: string }[] = await this.db.query(
      'SELECT "modelId" FROM price_history WHERE "offerId" = $1',
      [offerId],
    );
    if (rows.length === 0) report(false, 'the offer has price history to move');
    return rows.map((row) => row.modelId);
  }
}

function stubExternalCalls(app: App): void {
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

  (app.get(ProductImageCopyService) as unknown as {
    copyImagesFromSource: () => Promise<[]>;
  }).copyImagesFromSource = async () => [];

  // The dynamic config's switch, as this script sets it.
  Object.defineProperty(app.get(ListingReidentificationService), 'mode', {
    get: () => mode,
  });
}

async function createSources(app: App): Promise<Sources> {
  const sellerRepo = app.get(SellerRepository);
  const sourceRepo = app.get(ProductSourceRepository);
  const config = JSON.parse(readFileSync(CONFIG_FIXTURE, 'utf8'));
  delete config.maxItems;
  const sellerA = await sellerRepo.save(
    Object.assign(new Seller(), { name: SELLERS.a, type: SellerType.business }),
  );
  const sellerB = await sellerRepo.save(
    Object.assign(new Seller(), { name: SELLERS.b, type: SellerType.business }),
  );

  const create = async (name: string, seller: Seller, priority: number) => {
    const saved = await sourceRepo.save(
      Object.assign(new ProductSource(), {
        name,
        type: 'arukereso',
        seller,
        priority,
        fetchMode: 'direct',
        schedulingEnabled: false,
        processingEnabled: true,
        identifiesProducts: true,
        config: { ...config, feedUrl: `https://${PREFIX}.test/${name}.xml` },
      }),
    );
    return sourceRepo.findOneOrFail({ where: { id: saved.id }, relations: { seller: true } });
  };
  return {
    a: await create(SOURCES.a, sellerA, 60),
    a2: await create(SOURCES.a2, sellerA, 40),
    b: await create(SOURCES.b, sellerB, 60),
  };
}

async function wipe(db: DataSource, sources: Sources): Promise<void> {
  const ids = Object.values(sources).map((source) => source.id);
  const products: { id: string; embeddingId: string | null }[] = await db.query(
    `SELECT DISTINCT m.id, m."embeddingId" FROM product_model m
       JOIN product_source_record r ON r."productId" = m.id WHERE r."sourceId" = ANY($1)`,
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
  await db.query('DELETE FROM offer WHERE "sellerId" = ANY($1)', [
    [...new Set(Object.values(sources).map((source) => source.seller.id))],
  ]);
}

/** Whatever an earlier, interrupted run left: its sources and sellers. */
async function removeLeftovers(db: DataSource): Promise<void> {
  const names = Object.values(SOURCES);
  const leftovers: { id: string; sellerId: string; name: string }[] = await db.query(
    'SELECT id, "sellerId", name FROM product_source WHERE name = ANY($1)',
    [names],
  );
  if (leftovers.length > 0) {
    const sources = Object.fromEntries(
      leftovers.map((row) => [row.name, { id: row.id, seller: { id: row.sellerId } }]),
    ) as unknown as Sources;
    await wipe(db, sources);
  }
  const ids = leftovers.map((row) => row.id);
  await db.query('DELETE FROM product_source_version WHERE "sourceId" = ANY($1)', [ids]);
  await db.query('DELETE FROM product_source_action WHERE "sourceId" = ANY($1)', [ids]);
  await db.query('DELETE FROM product_source WHERE name = ANY($1)', [names]);
  await db.query('DELETE FROM seller WHERE name = ANY($1)', [Object.values(SELLERS)]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

