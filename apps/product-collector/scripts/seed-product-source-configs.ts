/**
 * One-time idempotent seed for the two ProductSource.config JSONB rows
 * (Arukereso, DisplaySpecs), reading the hand-authored config JSON from
 * libs/scrape-interpreter's fixtures directory (same files validated by
 * that library's test suite).
 *
 * No production ProductSource rows exist yet, so this always creates rather
 * than needing to preserve pre-existing scheduling state — but it upserts by
 * name regardless, so it's safe to re-run.
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
} from '@fittkereso-backend/database';
import * as fs from 'fs';
import * as path from 'path';
import type ms from 'ms';

const FIXTURES_DIR = path.resolve(
  __dirname,
  '../../../libs/scrape-interpreter/src/lib/interpreter/__fixtures__',
);

interface SeedSourceSpec {
  name: string;
  configFile: string;
  maxConcurrent: number;
  requestsPerHour: number;
  priority: number;
  fullSyncInterval: string;
  incrementalSyncInterval: string;
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
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const sourceRepo = app.get(ProductSourceRepository);

  try {
    for (const spec of SOURCES) {
      const configPath = path.join(FIXTURES_DIR, spec.configFile);
      const config: ProductSourceConfig = JSON.parse(
        fs.readFileSync(configPath, 'utf-8'),
      );

      const existing = await sourceRepo.findOne({
        where: { name: spec.name },
      });

      const source = existing ?? new ProductSource();
      if (!existing) {
        source.name = spec.name;
        source.maxConcurrent = spec.maxConcurrent;
        source.requestsPerHour = spec.requestsPerHour;
        source.priority = spec.priority;
        source.schedulingEnabled = true;
        source.processingEnabled = true;
        source.fullSyncInterval = spec.fullSyncInterval as ms.StringValue;
        source.incrementalSyncInterval =
          spec.incrementalSyncInterval as ms.StringValue;
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
