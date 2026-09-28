/**
 * Leaves one ProductSourceRecord per (source, externalId), so the unique
 * constraint on that pair can be created. Run it BEFORE the first boot that
 * syncs the schema to that constraint: the sync fails while duplicates exist.
 *
 * Records used to be keyed by (source, url), so a URL the shop renamed left a
 * second record of the listing behind. For each such group it keeps the record
 * the source saw last, points everything that referenced the others (offers,
 * resolutions) at it, and deletes the others.
 *
 * Every record of a source gets its key first, as imports now compute it
 * (listingExternalIdOf): its id trimmed, or its URL slug where it has none.
 *
 * Connects with a bare TypeORM DataSource, no entities and no sync, for the
 * same reason it exists: booting the app would sync the schema first.
 *
 * Dry run by default; --apply writes, in one transaction.
 *
 * Usage (from fittkereso-backend/):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=apps/product-collector/src/config/config.yaml \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/dedupe-source-records.ts [--apply]
 */
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { DataSource, EntityManager } from 'typeorm';
import { listingExternalIdOf } from '@fittkereso-backend/utils';

interface RecordRow {
  id: string;
  sourceId: string;
  sourceName: string;
  url: string | null;
  externalId: string | null;
  seenAt: Date;
  offers: number;
}

interface Referencing {
  table_name: string;
  column_name: string;
}

function connect(): DataSource {
  const configPath = process.env.PRODUCT_COLLECTOR_CONFIG_PATH;
  if (!configPath) throw new Error('Set PRODUCT_COLLECTOR_CONFIG_PATH to the collector config');
  const { postgres } = yaml.load(readFileSync(configPath, 'utf8')) as {
    postgres: { host: string; port: number; user: string; password: string; database: string; ssl?: boolean };
  };
  return new DataSource({
    type: 'postgres',
    host: postgres.host,
    port: postgres.port,
    username: postgres.user,
    password: postgres.password,
    database: postgres.database,
    ssl: postgres.ssl ? { rejectUnauthorized: false } : false,
    entities: [],
    synchronize: false,
  });
}

/** Every record of a source, with its key as an import computes it now. */
async function loadRecords(manager: EntityManager): Promise<(RecordRow & { key: string })[]> {
  const rows: RecordRow[] = await manager.query(
    `SELECT r.id, r."sourceId", s.name AS "sourceName", r.url, r."externalId",
            COALESCE(r."lastSeenAt", r."lastUpdated") AS "seenAt",
            (SELECT COUNT(*)::int FROM offer o WHERE o."sourceRecordId" = r.id) AS offers
       FROM product_source_record r
       JOIN product_source s ON s.id = r."sourceId"
      ORDER BY r."sourceId", "seenAt" DESC, r."updatedAt" DESC`,
  );
  return rows.map((row) => ({
    ...row,
    key: listingExternalIdOf({ externalId: row.externalId }, row.url ?? ''),
  }));
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dataSource = await connect().initialize();

  try {
    await dataSource.transaction(async (manager) => {
      const records = await loadRecords(manager);

      // Newest sighting first within a source, so the first of a group is kept.
      const groups = new Map<string, typeof records>();
      for (const record of records) {
        const group = `${record.sourceId}\u0000${record.key}`;
        groups.set(group, [...(groups.get(group) ?? []), record]);
      }
      const duplicates = [...groups.values()].filter((group) => group.length > 1);
      const rekeyed = [...groups.values()]
        .map(([kept]) => kept)
        .filter((kept) => kept.externalId !== kept.key);

      console.log(`${records.length} records of a source, ${groups.size} listings`);
      console.log(`\n${rekeyed.length} records get their key set:`);
      for (const record of rekeyed) {
        console.log(`  ${record.sourceName} ${record.id}: ${JSON.stringify(record.externalId)} -> ${record.key}`);
      }
      console.log(`\n${duplicates.length} listings hold several records:`);
      for (const [kept, ...removed] of duplicates) {
        console.log(`  ${kept.sourceName} ${kept.key}`);
        console.log(`    keep   ${kept.id} seen ${kept.seenAt.toISOString()} offers ${kept.offers} ${kept.url}`);
        for (const record of removed) {
          console.log(`    remove ${record.id} seen ${record.seenAt.toISOString()} offers ${record.offers} ${record.url}`);
        }
      }

      if (!apply) {
        console.log('\nDry run. Re-run with --apply to write.');
        return;
      }

      const referencing: Referencing[] = await manager.query(
        `SELECT kcu.table_name, kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND ccu.table_name = 'product_source_record'
            AND kcu.table_name <> 'product_source_record'`,
      );

      for (const [kept, ...removed] of duplicates) {
        const removedIds = removed.map((record) => record.id);
        for (const ref of referencing) {
          await manager.query(
            `UPDATE "${ref.table_name}" SET "${ref.column_name}" = $1 WHERE "${ref.column_name}" = ANY($2)`,
            [kept.id, removedIds],
          );
        }
        await manager.query(`DELETE FROM product_source_record WHERE id = ANY($1)`, [removedIds]);
      }
      for (const record of rekeyed) {
        await manager.query(`UPDATE product_source_record SET "externalId" = $1 WHERE id = $2`, [
          record.key,
          record.id,
        ]);
      }

      const [{ repeated }] = await manager.query(
        `SELECT COUNT(*)::int AS repeated FROM (
           SELECT 1 FROM product_source_record WHERE "sourceId" IS NOT NULL
            GROUP BY "sourceId", "externalId" HAVING COUNT(*) > 1) duplicates`,
      );
      if (repeated > 0) throw new Error(`${repeated} (source, externalId) pairs still repeat; rolled back`);
      console.log(
        `\nApplied: ${duplicates.reduce((sum, [, ...removed]) => sum + removed.length, 0)} records removed, ${rekeyed.length} rekeyed.`,
      );
    });
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
