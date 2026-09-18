/**
 * One-time idempotent seed for the ProductSource.config JSONB rows
 * (ebikeshop, speedbike), reading the hand-authored config JSON from
 * libs/scrape-interpreter's fixtures directory (same files validated by
 * that library's test suite).
 *
 * For a dev database this is the narrow, collector-side path: apps/api/src/
 * scripts/seed-dev-data.ts (npm run seed:dev-data) seeds these same two sellers
 * and sources from the same fixture files, alongside the brands and product
 * category dev needs. The two source lists must stay in step - this one exists
 * so the configs can be re-pushed without the api app.
 *
 * Upserts by name, so it's safe to re-run. Every source resolves-or-creates
 * its `seller` spec into a Seller row and links it via ProductSource.seller
 * — this is the sole source of truth for which seller every offer scraped
 * from this source belongs to (ProductSource.seller is non-nullable; there
 * is no per-offer sellerName in the scrape pipeline).
 *
 * Usage (from the repo root):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=apps/product-collector/src/config/config.yaml \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/seed-product-source-configs.ts
 *
 * Both parts are needed: without --project, ts-node resolves as ESM and can't
 * find the path aliases or the .ts extension; without the config-path
 * override, ConfigLoader looks for the copy webpack puts next to main.js.
 */
import { NestFactory } from '@nestjs/core';
import { ProductSourceVersionService } from '@fittkereso-backend/product';
import { AppModule } from '../src/app.module';
import {
  ProductSource,
  ProductSourceConfig,
  ProductSourceRepository,
  Seller,
  SellerRepository,
  SellerType,
  systemActor,
} from '@fittkereso-backend/database';
import * as fs from 'fs';
import * as path from 'path';
import type ms from 'ms';

const FIXTURES_DIR = path.resolve(
  __dirname,
  '../../../libs/scrape-interpreter/src/lib/interpreter/__fixtures__',
);

interface SeedSellerSpec {
  name: string;
  slug: string;
  domains: string[];
  // Nullable on the entity: unset means no seller-level cap, so only each
  // ProductSource's own limits apply. Where both are set the seller's cap wins,
  // across all of its sources combined.
  maxConcurrent?: number;
  requestsPerHour?: number;
}

interface SeedSourceSpec {
  name: string;
  configFile: string;
  maxConcurrent: number;
  requestsPerHour: number;
  priority: number;
  fullSyncInterval: string;
  seller: SeedSellerSpec;
  // Only applied when creating the row for the first time (existing rows
  // keep whatever scheduling state an operator already set). Defaults to
  // true when omitted — set false for a new source pending a manual dry-run
  // verification pass before it's allowed to run on the cron schedule.
  schedulingEnabled?: boolean;
}

const SOURCES: SeedSourceSpec[] = [
  {
    name: 'ebikeshop',
    configFile: 'ebikeshop.config.json',
    maxConcurrent: 2,
    requestsPerHour: 180,
    priority: 10,
    fullSyncInterval: '7 days',
    seller: {
      name: 'ebikeshop.hu',
      slug: 'ebikeshop-hu',
      domains: ['ebikeshop.hu'],
    },
    // First-time source: keep scheduling off until a manual dry run (one
    // list-page task run by hand, resulting Offer/ProductModel rows
    // inspected) confirms the config behaves as expected end to end.
    schedulingEnabled: false,
  },
  {
    name: 'speedbike',
    configFile: 'speedbike.config.json',
    maxConcurrent: 2,
    requestsPerHour: 120,
    priority: 10,
    fullSyncInterval: '7 days',
    seller: {
      name: 'speedbike.hu',
      slug: 'speedbike-hu',
      domains: ['speedbike.hu'],
      maxConcurrent: 2,
      requestsPerHour: 180,
    },
    // First-time source, also the first to use detailPage.postProcess —
    // keep scheduling off until a manual dry run confirms both the scrape
    // config and the LLM post-process pass behave as expected end to end.
    schedulingEnabled: false,
  },
];

async function resolveOrCreateSeller(
  sellerRepo: SellerRepository,
  spec: SeedSellerSpec,
): Promise<Seller> {
  const existing = await sellerRepo.findOne({ where: { name: spec.name } });
  if (existing) return existing;

  const seller = new Seller();
  seller.name = spec.name;
  seller.slug = spec.slug;
  seller.domains = spec.domains;
  seller.type = SellerType.business;
  seller.maxConcurrent = spec.maxConcurrent ?? null;
  seller.requestsPerHour = spec.requestsPerHour ?? null;
  seller.verified = true;
  seller.active = true;
  return sellerRepo.save(seller);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const sourceRepo = app.get(ProductSourceRepository);
  const sellerRepo = app.get(SellerRepository);
  const versionService = app.get(ProductSourceVersionService);

  try {
    for (const spec of SOURCES) {
      const configPath = path.join(FIXTURES_DIR, spec.configFile);
      const config: ProductSourceConfig = JSON.parse(
        fs.readFileSync(configPath, 'utf-8'),
      );

      const existing = await sourceRepo.findOne({
        where: { name: spec.name },
        relations: ['seller'],
      });

      const source = existing ?? new ProductSource();
      if (!existing) {
        source.name = spec.name;
        source.maxConcurrent = spec.maxConcurrent;
        source.requestsPerHour = spec.requestsPerHour;
        source.priority = spec.priority;
        source.schedulingEnabled = spec.schedulingEnabled ?? true;
        source.processingEnabled = true;
        source.fullSyncInterval = spec.fullSyncInterval as ms.StringValue;
      }

      source.seller = await resolveOrCreateSeller(sellerRepo, spec.seller);

      // Saved before the config, because the version service addresses a
      // source by id and a new row has none until it exists.
      const saved = await sourceRepo.save(source);

      // The config goes in as a VERSION rather than onto the column, so a
      // seeded source starts at v1 with a history like any other, and the
      // schema check happens on the way. Null when the fixture already matches
      // what is in force — the ordinary outcome of re-running this.
      //
      // It also ends this script's old habit of overwriting the column on every
      // run: an edit somebody made through the admin UI now becomes a version
      // this replaces rather than one that silently disappears.
      const version = await versionService.addVersionIfChanged(saved.id, config, {
        actor: systemActor('seed'),
        note: `Seeded from ${spec.configFile}`,
      });

      console.log(
        `${existing ? 'Updated' : 'Created'} ProductSource "${saved.name}" (id=${saved.id}), ` +
          `config: ${version ? `v${version.version}` : 'unchanged'}`,
      );
    }
  } finally {
    await app.close();
  }
}

main()
  .then(() => {
    // The Nest context keeps handles open, so the script would otherwise sit
    // here long after its work is committed, looking like a hang.
    process.exit(0);
  })
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
