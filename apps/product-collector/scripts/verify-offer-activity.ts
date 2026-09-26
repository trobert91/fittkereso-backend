/**
 * Checks the nightly stale-offer sweep against a real database: products whose
 * cheapest offer went stale are repriced, stale offers are deleted only for
 * sellers something still confirms, and a second run changes nothing.
 *
 * Seeds two sellers and seven products under the `offer-sweep-check` prefix,
 * with offers last synced 1, 4 and 15 days ago, or never:
 * - seller A is alive (it has offers synced a day ago);
 * - seller B is silent (nothing newer than 4 days): a broken or paused source.
 *
 * | product | offers                          | stored price | expected    |
 * |---------|---------------------------------|--------------|-------------|
 * | P1      | A 100 (1 d), A 80 (4 d)         | 80           | 100         |
 * | P2      | A 90 (4 d)                      | 90           | null        |
 * | P3      | A 200 (1 d)                     | 150 (wrong)  | 200         |
 * | P4      | B 70 (15 d), B 75 (4 d)         | 70           | null, kept  |
 * | P5      | A 60 (15 d)                     | 60           | null, gone  |
 * | P6      | A 50 (never synced)             | null         | null, kept  |
 * | P7      | A 120/130, A 120/140 (both 1 d) | null         | 120, the lower id's old price |
 *
 * The sweep runs over the whole database, so on `fittkereso_e2e` it also
 * reprices and deletes whatever earlier runs left there; the checks only look
 * at the seeded rows, except "a second run changes nothing", which holds
 * globally.
 *
 * DESTRUCTIVE on `fittkereso_e2e` only: it refuses any database whose name
 * does not end in `_e2e`, and deletes its seeded rows at the end. Deletion
 * runs because the repo's `offers.json` turns `offers.deletionEnabled` on.
 *
 * Usage (from fittkereso-backend/):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=<config pointing at a *_e2e database> \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/verify-offer-activity.ts
 */
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, In, Like } from 'typeorm';
import {
  Brand,
  Offer,
  OfferCondition,
  ProductEmbedding,
  ProductModel,
  Seller,
  SellerType,
} from '@fittkereso-backend/database';
import { OfferFreshnessService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { StaleOfferSweepService } from '@fittkereso-backend/product';
import { AppModule } from '../src/app.module';

const PREFIX = 'offer-sweep-check';
const SELLER_A = `${PREFIX}-alive`;
const SELLER_B = `${PREFIX}-silent`;
const DAY = 24 * 60 * 60 * 1000;
const EMBEDDING_DIMENSIONS = 1536;

let failures = 0;
const report = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Postgres returns numeric columns as strings. */
const asNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

async function main(): Promise<void> {
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
      `Refusing to run against "${database}": this script deletes offers. Point it at a *_e2e database.`,
    );
  }

  const freshness = app.get(OfferFreshnessService);
  console.log(
    `${database}: freshnessDays=${freshness.freshnessDays}, deleteAfterDays=${freshness.deleteAfterDays}, deletionEnabled=${freshness.deletionEnabled}`,
  );
  report(
    freshness.freshnessDays === 3 && freshness.deleteAfterDays === 14 && freshness.deletionEnabled,
    'offers.json is loaded',
  );

  const warnings: { message: unknown; meta: Record<string, unknown> }[] = [];
  const warn = recordWarnings(warnings);

  try {
    await removeSeed(db);
    const seed = await createSeed(db);

    const sweep = app.get(StaleOfferSweepService);
    const first = await sweep.sweep();
    console.log('first run:', JSON.stringify(first));

    const price = async (name: string) => {
      const product = await db.getRepository(ProductModel).findOneOrFail({
        where: { id: seed.products[name].id },
      });
      return {
        price: asNumber(product.price),
        priceWithoutDiscount: asNumber(product.priceWithoutDiscount),
      };
    };

    const p1 = await price('P1');
    report(p1.price === 100, 'P1 takes its fresh offer\'s price once the cheaper one is stale', `${p1.price}`);
    const p2 = await price('P2');
    report(p2.price === null, 'P2, with only a stale offer, has no price', `${p2.price}`);
    const p3 = await price('P3');
    report(p3.price === 200, 'P3\'s wrong stored price is repaired', `${p3.price}`);
    const p4 = await price('P4');
    report(p4.price === null, 'P4, a silent seller\'s product, has no price', `${p4.price}`);
    const p5 = await price('P5');
    report(p5.price === null, 'P5, whose only offer was deleted, has no price', `${p5.price}`);
    const p6 = await price('P6');
    report(p6.price === null, 'P6, with a never-synced offer, has no price', `${p6.price}`);

    const [lowerId, higherId] = [...seed.ties].sort((a, b) => a.id.localeCompare(b.id));
    const p7 = await price('P7');
    report(
      p7.price === 120 && p7.priceWithoutDiscount === asNumber(lowerId.priceWithoutDiscount),
      'P7 takes the lower id\'s offer among two at the same price',
      `${p7.price}/${p7.priceWithoutDiscount} (lower id ${lowerId.priceWithoutDiscount}, higher ${higherId.priceWithoutDiscount})`,
    );

    const remaining = new Set(
      (
        await db.getRepository(Offer).find({
          where: { id: In(Object.values(seed.offers).map((offer) => offer.id)) },
          select: { id: true },
        })
      ).map((offer) => offer.id),
    );
    report(!remaining.has(seed.offers.a15.id), 'A\'s 15-day-old offer is deleted');
    report(remaining.has(seed.offers.b15.id), 'B\'s 15-day-old offer is kept: nothing of B is confirmed');
    report(remaining.has(seed.offers.b4.id), 'B\'s 4-day-old offer is kept');
    report(remaining.has(seed.offers.never.id), 'the never-synced offer is kept');
    report(remaining.has(seed.offers.a4.id), 'A\'s 4-day-old offer is kept (stale, not yet deletable)');

    const aboutB = warnings.filter((warning) => warning.meta?.['seller'] === SELLER_B);
    report(
      aboutB.length === 1 && aboutB[0].meta['kept'] === 1,
      'one warning about B, keeping its one deletable offer',
      JSON.stringify(aboutB.map((warning) => warning.meta)),
    );
    report(first.keptForSilentSellers >= 1, 'the result counts the kept offers', `${first.keptForSilentSellers}`);

    const second = await sweep.sweep();
    console.log('second run:', JSON.stringify(second));
    report(
      second.productsRepriced === 0 && second.deleted === 0,
      'a second run reprices nothing and deletes nothing',
      `repriced ${second.productsRepriced}, deleted ${second.deleted}`,
    );
  } finally {
    warn.mockRestore();
    await removeSeed(db);
    await app.close();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  // Explicitly: a closed application context still leaves handles open.
  process.exit(failures === 0 ? 0 : 1);
}

/** Records CustomLogger warnings (the sweep logs through it), without jest. */
function recordWarnings(
  into: { message: unknown; meta: Record<string, unknown> }[],
): { mockRestore: () => void } {
  const original = CustomLogger.prototype.warn;
  CustomLogger.prototype.warn = function (message: unknown, ...rest: unknown[]) {
    into.push({ message, meta: (rest[0] ?? {}) as Record<string, unknown> });
  };
  return { mockRestore: () => (CustomLogger.prototype.warn = original) };
}

interface Seed {
  products: Record<string, ProductModel>;
  offers: Record<'a15' | 'a4' | 'b15' | 'b4' | 'never', Offer>;
  ties: Offer[];
}

async function createSeed(db: DataSource): Promise<Seed> {
  const sellers = db.getRepository(Seller);
  const a = await sellers.save(Object.assign(new Seller(), { name: SELLER_A, type: SellerType.business }));
  const b = await sellers.save(Object.assign(new Seller(), { name: SELLER_B, type: SellerType.business }));
  const brand = await db
    .getRepository(Brand)
    .save(Object.assign(new Brand(), { name: `${PREFIX}-brand` }));

  const products: Record<string, ProductModel> = {};
  const product = async (name: string, price: number | null) => {
    products[name] = await db.getRepository(ProductModel).save(
      Object.assign(new ProductModel(), {
        brand,
        displayName: `${PREFIX} ${name}`,
        model: name,
        normalizedName: `${PREFIX} ${name}`.toLowerCase(),
        price,
        priceWithoutDiscount: null,
        embedding: Object.assign(new ProductEmbedding(), {
          embedding: new Array(EMBEDDING_DIMENSIONS).fill(0),
        }),
      }),
    );
    return products[name];
  };

  const now = Date.now();
  let offerCount = 0;
  const offer = (
    model: ProductModel,
    seller: Seller,
    price: number,
    ageDays: number | null,
    priceWithoutDiscount: number | null = null,
  ) =>
    db.getRepository(Offer).save(
      Object.assign(new Offer(), {
        model,
        seller,
        condition: OfferCondition.new,
        price,
        priceWithoutDiscount,
        currency: 'HUF',
        externalId: `${PREFIX}-${++offerCount}`,
        lastSynced: ageDays === null ? null : new Date(now - ageDays * DAY),
      }),
    );

  const p1 = await product('P1', 80);
  await offer(p1, a, 100, 1);
  await offer(p1, a, 80, 4);
  const p2 = await product('P2', 90);
  const a4 = await offer(p2, a, 90, 4);
  const p3 = await product('P3', 150);
  await offer(p3, a, 200, 1);
  const p4 = await product('P4', 70);
  const b15 = await offer(p4, b, 70, 15);
  const b4 = await offer(p4, b, 75, 4);
  const p5 = await product('P5', 60);
  const a15 = await offer(p5, a, 60, 15);
  const p6 = await product('P6', null);
  const never = await offer(p6, a, 50, null);
  const p7 = await product('P7', null);
  const ties = [await offer(p7, a, 120, 1, 130), await offer(p7, a, 120, 1, 140)];

  return { products, offers: { a15, a4, b15, b4, never }, ties };
}

/** Deleting a product deletes its offers (onDelete CASCADE); the seeded offers are all on seeded products. */
async function removeSeed(db: DataSource): Promise<void> {
  const products = await db.getRepository(ProductModel).find({
    where: { displayName: Like(`${PREFIX} %`) },
    relations: { embedding: true },
  });
  if (products.length > 0) {
    await db.getRepository(ProductModel).delete({ id: In(products.map((p) => p.id)) });
    const embeddingIds = products.flatMap((p) => (p.embedding ? [p.embedding.id] : []));
    if (embeddingIds.length > 0) {
      await db.getRepository(ProductEmbedding).delete({ id: In(embeddingIds) });
    }
  }
  await db.getRepository(Seller).delete({ name: In([SELLER_A, SELLER_B]) });
  await db.getRepository(Brand).delete({ name: `${PREFIX}-brand` });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
