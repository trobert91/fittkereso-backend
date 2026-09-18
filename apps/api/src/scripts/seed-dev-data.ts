/**
 * Seeds the reference data a dev database needs to be usable: brands, product
 * categories, sellers, and the sellers' product sources with their scrape
 * configs.
 *
 *   npm run seed:dev-data   # this script on its own
 *   npm run seed:dev        # the admin accounts (seed-users.ts) and then this
 *
 * The rows here are not invented fixtures - they mirror what the dev database
 * (127.0.0.1:5432/fittkereso) actually held on 2026-09-18, so a re-created dev
 * DB comes back with the same brands, category, sellers and sources the running
 * dev environment was built on. The two scrape configs are read from
 * libs/scrape-interpreter's fixtures, the same hand-authored files that
 * library's test suite validates and that
 * apps/product-collector/scripts/seed-product-source-configs.ts pushes from the
 * collector app. Keep the two source lists in step if either changes.
 *
 * Dev only, and it refuses to run against a prod config: brands and sellers are
 * harmless, but the source rows carry dev tuning (rate limits, scheduling off)
 * that has no business landing on a live source.
 *
 * Idempotent, and deliberately narrow about what a re-run may touch. Rows are
 * matched by name; an existing row keeps every operator-tunable field (rate
 * limits, priority, scheduling/processing flags, verified/active), because
 * those get adjusted by hand and a re-run must not quietly revert them. The one
 * exception is ProductSource.config, which is always refreshed from the fixture
 * JSON - that file, not the database, is where the config is authored.
 *
 * The config goes in through ProductSourceVersionService rather than onto the
 * column, so a seeded source starts at v1 with a history like any other. That
 * also makes the refresh above safe to repeat: an unchanged fixture is a no-op
 * rather than a new version, and a changed one appends the next version instead
 * of overwriting what was there. A config the schema rejects stops the seed
 * rather than being written for a scrape task to fail on later.
 *
 * Usage without npm:
 *   API_CONFIG_PATH=apps/api/src/config/config.yaml npx ts-node \
 *     --project apps/api/tsconfig.app.json -r tsconfig-paths/register \
 *     apps/api/src/scripts/seed-dev-data.ts
 *
 * --project is required: without it ts-node resolves as ESM and cannot find the
 * path aliases.
 */
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';
import { FindOptionsWhere } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import type ms from 'ms';
import {
  BasePostgresEntity,
  BasePostgresRepository,
  Brand,
  BrandRepository,
  ProductCategory,
  ProductCategoryRepository,
  ProductSource,
  ProductSourceConfig,
  ProductSourceRepository,
  Seller,
  SellerRepository,
  SellerType,
  systemActor,
} from '@fittkereso-backend/database';
import { ProductSourceVersionService } from '@fittkereso-backend/product';
import { generateSlug, nameOf } from '@fittkereso-backend/utils';
import { AppModule } from '../app.module';
import { AppConfigService } from '../modules/app-config/services/app-config.service';

const FIXTURES_DIR = path.resolve(
  __dirname,
  '../../../../libs/scrape-interpreter/src/lib/interpreter/__fixtures__',
);

/**
 * Every brand the dev database knows. They were all created by the scraper as
 * it met them, so the list is exactly the ebike brands the two sources sell.
 */
const BRAND_NAMES = [
  'Brennabor',
  'Corratec',
  'Cube',
  'Ghost',
  'Haibike',
  'Hercules',
  'KTM',
  'Rideonic',
  'Riese und Müller',
  'Victoria',
  'Winora',
];

interface SeedCategorySpec {
  name: string;
  enabled: boolean;
}

/**
 * A category's slug has to match its spec-definition directory under
 * libs/config/src/lib/categories/<slug>/, so "Ebikes" must slugify to "ebikes"
 * - which is what generateSlug does. Renaming a category here without moving
 * that directory leaves it with no spec definition.
 */
const CATEGORIES: SeedCategorySpec[] = [{ name: 'Ebikes', enabled: true }];

interface SeedSellerSpec {
  name: string;
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
  schedulingEnabled: boolean;
  processingEnabled: boolean;
  fullSyncInterval: string;
  seller: SeedSellerSpec;
}

/**
 * The sellers are created from each source's `seller` spec and linked through
 * ProductSource.seller, which is the sole authority on which seller an offer
 * scraped from that source belongs to (the column is non-nullable and there is
 * no per-offer sellerName in the pipeline). A seller's name must match the
 * `detailPage.offers.sellerName` literal in its config, since scrape-time
 * seller resolution is by exact name.
 *
 * Do not add a second source for a site that already has one:
 * ProductSourceRecord.url is globally unique and deduplication runs across all
 * sources, so the newer source silently skips every URL the first one owns.
 */
const SOURCES: SeedSourceSpec[] = [
  {
    name: 'ebikeshop',
    configFile: 'ebikeshop.config.json',
    maxConcurrent: 2,
    requestsPerHour: 180,
    priority: 10,
    // Scheduling stays off, as it is in dev: neither config has a `discovery`
    // block, so a scheduled sync would do nothing anyway - runs are enqueued as
    // list-page tasks by hand (see apps/product-collector/scripts/
    // enqueue-ktm-catalog.ts). Processing is what lets the poller claim them.
    schedulingEnabled: false,
    processingEnabled: true,
    fullSyncInterval: '7 days',
    seller: {
      name: 'ebikeshop.hu',
      domains: ['ebikeshop.hu'],
    },
  },
  {
    name: 'speedbike',
    configFile: 'speedbike.config.json',
    maxConcurrent: 2,
    requestsPerHour: 120,
    priority: 10,
    schedulingEnabled: false,
    processingEnabled: true,
    fullSyncInterval: '7 days',
    seller: {
      name: 'speedbike.hu',
      domains: ['speedbike.hu'],
      maxConcurrent: 2,
      requestsPerHour: 180,
    },
  },
];

function assertNotProd(app: INestApplicationContext): void {
  const environment = app.get(AppConfigService).environment;

  if (environment === 'prod') {
    throw new Error(
      'Refusing to seed dev data against a config with environment "prod". ' +
        'Check API_CONFIG_PATH points at the right config.yaml.',
    );
  }
}

/**
 * Slugs are generated from the name, exactly as the create services do, so a
 * seeded row is indistinguishable from one added through the API later. The
 * empty id argument is only generateSlug's fallback for a name that slugifies to
 * nothing, which none of the names here do.
 *
 * A collision throws rather than inventing a suffix: it means another row of the
 * same kind already owns this slug under a different name, which is a conflict a
 * person should look at, not something a seed should paper over.
 */
async function slugFor<T extends BasePostgresEntity & { slug?: string | null }>(
  repository: BasePostgresRepository<T>,
  name: string,
): Promise<string> {
  const slug = generateSlug('', name);
  const collision = await repository.findOne({
    where: { slug } as FindOptionsWhere<T>,
  });

  if (collision) {
    throw new Error(
      `Cannot seed "${name}": slug "${slug}" is already taken by row ` +
        `${collision.id}. Rename or remove that row and re-run.`,
    );
  }

  return slug;
}

async function seedBrands(app: INestApplicationContext): Promise<void> {
  const brandRepository = app.get(BrandRepository);

  for (const name of BRAND_NAMES) {
    const existing = await brandRepository.findOne({ where: { name } });
    if (existing) {
      console.log(`Brand "${name}" already exists (${existing.id}).`);
      continue;
    }

    const brand = new Brand();
    brand.name = name;
    brand.domains = [];
    brand.slug = await slugFor(brandRepository, name);

    const saved = await brandRepository.save(brand);
    console.log(`Created Brand "${name}" (${saved.id}, slug: ${saved.slug}).`);
  }
}

async function seedCategories(app: INestApplicationContext): Promise<void> {
  const categoryRepository = app.get(ProductCategoryRepository);

  for (const spec of CATEGORIES) {
    const existing = await categoryRepository.findByName(spec.name);
    if (existing) {
      console.log(
        `ProductCategory "${spec.name}" already exists ` +
          `(${existing.id}, slug: ${existing.slug}).`,
      );
      continue;
    }

    const category = new ProductCategory();
    category.name = spec.name;
    category.enabled = spec.enabled;
    category.slug = await slugFor(categoryRepository, spec.name);

    const saved = await categoryRepository.save(category);
    console.log(
      `Created ProductCategory "${spec.name}" (${saved.id}, slug: ${saved.slug}).`,
    );
  }
}

async function resolveOrCreateSeller(
  app: INestApplicationContext,
  spec: SeedSellerSpec,
): Promise<Seller> {
  const sellerRepository = app.get(SellerRepository);

  const existing = await sellerRepository.findOne({
    where: { name: spec.name },
  });
  if (existing) {
    console.log(`Seller "${spec.name}" already exists (${existing.id}).`);

    return existing;
  }

  const seller = new Seller();
  seller.name = spec.name;
  seller.domains = spec.domains;
  seller.type = SellerType.business;
  seller.maxConcurrent = spec.maxConcurrent ?? null;
  seller.requestsPerHour = spec.requestsPerHour ?? null;
  seller.verified = true;
  seller.active = true;
  seller.slug = await slugFor(sellerRepository, spec.name);

  const saved = await sellerRepository.save(seller);
  console.log(
    `Created Seller "${spec.name}" (${saved.id}, slug: ${saved.slug}).`,
  );

  return saved;
}

function readConfig(configFile: string): ProductSourceConfig {
  const configPath = path.join(FIXTURES_DIR, configFile);

  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

async function seedSources(app: INestApplicationContext): Promise<void> {
  const sourceRepository = app.get(ProductSourceRepository);
  const versionService = app.get(ProductSourceVersionService);

  for (const spec of SOURCES) {
    const existing = await sourceRepository.findOne({
      where: { name: spec.name },
      relations: [nameOf<ProductSource>('seller')],
    });

    const source = existing ?? new ProductSource();
    if (!existing) {
      source.name = spec.name;
      source.maxConcurrent = spec.maxConcurrent;
      source.requestsPerHour = spec.requestsPerHour;
      source.priority = spec.priority;
      source.schedulingEnabled = spec.schedulingEnabled;
      source.processingEnabled = spec.processingEnabled;
      source.fullSyncInterval = spec.fullSyncInterval as ms.StringValue;
    }

    source.seller = await resolveOrCreateSeller(app, spec.seller);

    // Saved WITHOUT the config first, because the version service addresses a
    // source by id and a new row has none until it exists. A brand-new source
    // is briefly configless, which is the state the column default already
    // describes and which the next statement resolves.
    const saved = await sourceRepository.save(source);

    // The config, as a version rather than a column write. Returns null when
    // the fixture matches what is already in force, which is the ordinary
    // outcome of re-running the seed.
    const version = await versionService.addVersionIfChanged(
      saved.id,
      readConfig(spec.configFile),
      {
        actor: systemActor('seed'),
        note: `Seeded from ${spec.configFile}`,
      },
    );

    console.log(
      `${existing ? 'Updated' : 'Created'} ProductSource "${saved.name}" ` +
        `(${saved.id}, seller: ${saved.seller.name}, ` +
        `config: ${version ? `v${version.version}` : 'unchanged'}).`,
    );
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    assertNotProd(app);

    await seedBrands(app);
    await seedCategories(app);
    // Sellers are seeded through their sources, which own the link.
    await seedSources(app);
  } finally {
    await app.close();
  }
}

bootstrap()
  .then(() => {
    // The Nest context keeps handles open, so the script would otherwise sit
    // here long after its work is committed, looking like a hang.
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      'Failed to seed dev data:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
