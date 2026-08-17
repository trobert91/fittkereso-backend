/**
 * One-time idempotent seed for the ProductSource.config JSONB rows
 * (Arukereso, DisplaySpecs, ebikeshop, speedbike), reading the hand-authored
 * config JSON from libs/scrape-interpreter's fixtures directory (same files
 * validated by that library's test suite).
 *
 * Upserts by name, so it's safe to re-run. Sources with a `seller` spec
 * (single-storefront sources like ebikeshop, as opposed to aggregators like
 * Arukereso/DisplaySpecs which have none) also resolve-or-create the
 * matching Seller row by exact name and link it via ProductSource.seller —
 * the name here must match byte-for-byte what the config's
 * detailPage.offers.sellerName pipeline emits, since SellerResolutionService
 * (used at scrape time) does exact-name lookup, not fuzzy matching.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register apps/product-collector/scripts/seed-product-source-configs.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  ProductSource,
  ProductSourceConfig,
  ProductSourceRepository,
  Seller,
  SellerRepository,
  SellerType,
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
}

interface SeedSourceSpec {
  name: string;
  configFile: string;
  maxConcurrent: number;
  requestsPerHour: number;
  priority: number;
  fullSyncInterval: string;
  incrementalSyncInterval: string;
  seller?: SeedSellerSpec;
  // Only applied when creating the row for the first time (existing rows
  // keep whatever scheduling state an operator already set). Defaults to
  // true when omitted — set false for a new source pending a manual dry-run
  // verification pass before it's allowed to run on the cron schedule.
  schedulingEnabled?: boolean;
}

const SOURCES: SeedSourceSpec[] = [
  {
    name: 'arukereso',
    configFile: 'arukereso.config.json',
    maxConcurrent: 1,
    requestsPerHour: 60,
    priority: 10,
    fullSyncInterval: '7 days',
    incrementalSyncInterval: '1 day',
  },
  {
    name: 'displayspecs',
    configFile: 'displayspecs.config.json',
    maxConcurrent: 1,
    requestsPerHour: 60,
    priority: 5,
    fullSyncInterval: '7 days',
    incrementalSyncInterval: '1 day',
  },
  {
    name: 'ebikeshop',
    configFile: 'ebikeshop.config.json',
    maxConcurrent: 2,
    requestsPerHour: 60,
    priority: 10,
    fullSyncInterval: '7 days',
    incrementalSyncInterval: '1 day',
    seller: {
      name: 'ebikeshop.hu',
      slug: 'ebikeshop',
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
    requestsPerHour: 60,
    priority: 10,
    fullSyncInterval: '7 days',
    incrementalSyncInterval: '1 day',
    seller: {
      name: 'speedbike.hu',
      slug: 'speedbike',
      domains: ['speedbike.hu'],
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
  seller.verified = true;
  seller.active = true;
  return sellerRepo.save(seller);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const sourceRepo = app.get(ProductSourceRepository);
  const sellerRepo = app.get(SellerRepository);

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
        source.incrementalSyncInterval =
          spec.incrementalSyncInterval as ms.StringValue;
      }

      if (spec.seller) {
        source.seller = await resolveOrCreateSeller(sellerRepo, spec.seller);
      }

      source.config = config;
      const saved = await sourceRepo.save(source);

      console.log(
        `${existing ? 'Updated' : 'Created'} ProductSource "${saved.name}" (id=${saved.id})`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
