/**
 * One-time idempotent seed for the ProductSource.config JSONB rows —
 * ebikeshop (scraping) and speedbike-arukereso (feed) — reading the
 * hand-authored config JSON from libs/scrape-interpreter's fixtures directory
 * (the same files validated by that library's test suite).
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
  ProductSourceType,
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
  /** Fixed at creation — the config format is type-bound. */
  type: ProductSourceType;
  configFile: string;
  maxConcurrent: number;
  requestsPerHour: number;
  /** Unique per seller: the higher one overwrites the lower one field by field. */
  priority: number;
  /** Whether the source creates products and offers; a seller needs one that does. */
  identifiesProducts: boolean;
  /** Whether a complete run may remove the offers it did not see. Feed sources only. */
  hasAllProducts: boolean;
  frequency: string;
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
    type: 'scraping',
    configFile: 'ebikeshop.config.json',
    maxConcurrent: 2,
    requestsPerHour: 180,
    priority: 50,
    identifiesProducts: true,
    hasAllProducts: false,
    frequency: '7 days',
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
    // speedbike is FEED-ONLY — its scraping source is deliberately not seeded.
    // `speedbike.config.json` stays as a fixture (the table-based markup
    // template the add-webshop skill points at, with its interpreter specs
    // still running), but one Árukereső GET replaces thousands of paid page
    // fetches for the same catalogue.
    //
    // The arrangement is still the one ProductSourceRecord's composite unique
    // exists for: a seller may carry several sources, records stay per-source,
    // and offers converge through the (seller, externalId) constraint.
    name: 'speedbike-arukereso',
    type: 'arukereso',
    configFile: 'speedbike-arukereso.config.json',
    // A feed run makes exactly one HTTP request and enqueues no import tasks,
    // so these caps govern nothing here. Set low rather than copied from the
    // scraping source, so the row does not imply a fetch budget it never uses.
    maxConcurrent: 1,
    requestsPerHour: 10,
    priority: 60,
    identifiesProducts: true,
    // The feed is what says what the shop sells, so an item missing from a
    // complete run is gone.
    hasAllProducts: true,
    // Nightly: one native GET costs nothing, and the LLM post-process is
    // skipped for every product whose specs did not change.
    frequency: '1 day',
    seller: {
      name: 'speedbike.hu',
      slug: 'speedbike-hu',
      domains: ['speedbike.hu'],
      maxConcurrent: 2,
      requestsPerHour: 180,
    },
    // Off until a manual dry run confirms the mapping, the category gate and
    // the identity keying behave as expected against the live feed.
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
        // Fixed at creation and never changed afterwards — the config format
        // is type-bound, so a type change would reinterpret a stored document.
        source.type = spec.type;
        source.maxConcurrent = spec.maxConcurrent;
        source.requestsPerHour = spec.requestsPerHour;
        source.priority = spec.priority;
        source.identifiesProducts = spec.identifiesProducts;
        source.hasAllProducts = spec.hasAllProducts;
        source.schedulingEnabled = spec.schedulingEnabled ?? true;
        source.processingEnabled = true;
        source.frequency = spec.frequency as ms.StringValue;
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
