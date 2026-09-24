/**
 * Deletes a ProductSource, after showing exactly what goes with it.
 *
 * A source delete is not a single-row delete: foreign keys cascade it into the
 * source's records, and from there into whatever those records own. This prints
 * every referencing table with its delete rule and row count FIRST, and only
 * proceeds when `--confirm` is passed — so the blast radius is something you
 * read rather than something you find out.
 *
 * Generate the revert file before running this:
 *   dump-product-source-revert-sql.ts <name> scripts/revert-delete-<name>.sql
 *
 * Usage (from fittkereso-backend/):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=apps/product-collector/src/config/config.yaml \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/delete-product-source.ts <source-name> [--confirm]
 */
import { NestFactory } from '@nestjs/core';
import {
  ProductModelRepository,
  ProductSourceRepository,
} from '@fittkereso-backend/database';
import { ProductMergeService } from '@fittkereso-backend/product';
import { AppModule } from '../src/app.module';

interface Referencing {
  table_name: string;
  column_name: string;
  delete_rule: string;
}

async function main(): Promise<void> {
  const [name, ...flags] = process.argv.slice(2);
  const confirmed = flags.includes('--confirm');
  if (!name) {
    console.error('Usage: delete-product-source.ts <source-name> [--confirm]');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  try {
    const repo = app.get(ProductSourceRepository);
    const manager = repo.repo.manager;
    const sourceTable = repo.repo.metadata.tableName;

    const [source] = await manager.query(
      `SELECT id, name, type FROM "${sourceTable}" WHERE name = $1`,
      [name],
    );
    if (!source) throw new Error(`No ProductSource named "${name}"`);

    const referencing: Referencing[] = await manager.query(
      `SELECT tc.table_name, kcu.column_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
         JOIN information_schema.referential_constraints rc
           ON tc.constraint_name = rc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = $1`,
      [sourceTable],
    );

    console.log(`ProductSource "${source.name}" (${source.id}, type "${source.type}")`);
    console.log('Referencing rows:');

    const recordTables: string[] = [];
    for (const ref of referencing) {
      const [{ n }] = await manager.query(
        `SELECT COUNT(*)::int AS n FROM "${ref.table_name}" WHERE "${ref.column_name}" = $1`,
        [source.id],
      );
      console.log(
        `  ${ref.table_name}.${ref.column_name}: ${n} row(s) — ON DELETE ${ref.delete_rule}`,
      );
      if (ref.table_name === 'product_source_record' && n > 0) {
        recordTables.push(ref.column_name);
      }
    }

    // One level deeper, because this is where the surprise lives: the offers
    // belong to the RECORDS, not to the source, so they are invisible in the
    // list above even though the cascade reaches them.
    if (recordTables.length) {
      const secondLevel: Referencing[] = await manager.query(
        `SELECT tc.table_name, kcu.column_name, rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name
           JOIN information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND ccu.table_name = 'product_source_record'`,
      );

      console.log('Rows hanging off those records:');
      for (const ref of secondLevel) {
        const [{ n }] = await manager.query(
          `SELECT COUNT(*)::int AS n FROM "${ref.table_name}" r
            WHERE r."${ref.column_name}" IN (
              SELECT id FROM "product_source_record" WHERE "${recordTables[0]}" = $1
            )`,
          [source.id],
        );
        console.log(
          `  ${ref.table_name}.${ref.column_name}: ${n} row(s) — ON DELETE ${ref.delete_rule}`,
        );
      }
    }

    if (!confirmed) {
      console.log('\nDry run. Re-run with --confirm to delete.');
      return;
    }

    // A plain DELETE on the source does NOT work, in two separate ways:
    //
    //  - `scrape_task.sourceId` and `product_image.sourceId` are ON DELETE NO
    //    ACTION, so Postgres refuses the delete outright while any exist.
    //  - `product_source_record.sourceId` is ON DELETE SET NULL, not CASCADE.
    //    So even once that cleared, the records would SURVIVE with a null
    //    source — orphans still attached to products, carrying specs, but
    //    invisible to every source-scoped query, and never cleaned up by
    //    anything. Worse than deleting them.
    //
    // Hence an explicit order, in one transaction.
    const affectedModelIds: string[] = [];

    await manager.transaction(async (tx) => {
      // Images belong to the PRODUCT, not to the source — the source is only
      // where they came from. Keep them, drop the provenance.
      const images = await tx.query(
        `UPDATE "product_image" SET "sourceId" = NULL WHERE "sourceId" = $1`,
        [source.id],
      );
      console.log(`  product_image: provenance cleared (${images[1] ?? 0})`);

      // A task whose source is gone can never run.
      const tasks = await tx.query(
        `DELETE FROM "scrape_task" WHERE "sourceId" = $1`,
        [source.id],
      );
      console.log(`  scrape_task: deleted (${tasks[1] ?? 0})`);

      // Remember whose prices need recomputing before the offers vanish.
      const models = await tx.query(
        `SELECT DISTINCT o."modelId" AS id
           FROM "offer" o
          WHERE o."sourceRecordId" IN (
            SELECT id FROM "product_source_record" WHERE "sourceId" = $1
          )`,
        [source.id],
      );
      affectedModelIds.push(...models.map((m: { id: string }) => m.id));

      // An offer whose record is gone has no provenance and nothing will ever
      // refresh it — it would sit at a frozen price until the 14-day sweep.
      const offers = await tx.query(
        `DELETE FROM "offer"
          WHERE "sourceRecordId" IN (
            SELECT id FROM "product_source_record" WHERE "sourceId" = $1
          )`,
        [source.id],
      );
      console.log(`  offer: deleted (${offers[1] ?? 0})`);

      const records = await tx.query(
        `DELETE FROM "product_source_record" WHERE "sourceId" = $1`,
        [source.id],
      );
      console.log(`  product_source_record: deleted (${records[1] ?? 0})`);

      // Versions and actions cascade with the source itself.
      await tx.query(`DELETE FROM "${sourceTable}" WHERE id = $1`, [source.id]);
    });

    console.log(`\nDeleted ProductSource "${source.name}" (${source.id}).`);

    // ProductModel.price is denormalized from the cheapest offer, and it is
    // what the public listing sorts and filters on — leaving it pointing at a
    // deleted offer's price is exactly the kind of stale number nobody notices.
    if (affectedModelIds.length) {
      const mergeService = app.get(ProductMergeService);
      const modelRepo = app.get(ProductModelRepository);

      let recomputed = 0;
      for (const id of affectedModelIds) {
        const model = await modelRepo.findOne({
          where: { id },
          relations: ['offers'],
        });
        if (!model) continue;
        await mergeService.recomputePrice(model);
        await modelRepo.save(model);
        recomputed += 1;
      }
      console.log(`Recomputed price on ${recomputed} product(s).`);
    }
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
