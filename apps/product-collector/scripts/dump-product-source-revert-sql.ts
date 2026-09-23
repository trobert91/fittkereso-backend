/**
 * Writes a revert SQL file for a ProductSource, then reports everything a
 * delete would take with it.
 *
 * Deleting a source is cheap to do and expensive to undo: the row carries a
 * hand-authored config that took a day of page reading to write, plus its whole
 * version history. This dumps both as INSERT statements before anything is
 * removed, so the definition can be restored with `psql -f`.
 *
 * Column names are read from the live table rather than from the entity, so a
 * generated INSERT cannot drift from the schema it has to restore into.
 *
 * What it does NOT restore: the ProductSourceRecords, Offers and ScrapeTasks
 * that hang off the source. Those are re-derivable by running the source again,
 * which is the whole point of having the config back, and dumping them would
 * turn a reviewable file into a database export. The counts it prints say
 * exactly how much data the delete destroys, so that is a decision rather than
 * a surprise.
 *
 * Usage (from fittkereso-backend/):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=apps/product-collector/src/config/config.yaml \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/dump-product-source-revert-sql.ts <source-name> <out-file>
 */
import { NestFactory } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import { ProductSourceRepository } from '@fittkereso-backend/database';
import { AppModule } from '../src/app.module';

/** Postgres literal for a value straight out of pg's row object. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Dollar-quoting, so a config full of quotes, backslashes and regex escapes
  // survives without an escaping pass that could silently corrupt it.
  return `$revert$${text}$revert$`;
}

function insertStatement(table: string, row: Record<string, unknown>): string {
  const columns = Object.keys(row);
  return (
    `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})\n` +
    `VALUES (${columns.map((c) => literal(row[c])).join(', ')});`
  );
}

async function main(): Promise<void> {
  const [name, outFile] = process.argv.slice(2);
  if (!name || !outFile) {
    console.error(
      'Usage: dump-product-source-revert-sql.ts <source-name> <out-file>',
    );
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
      `SELECT * FROM "${sourceTable}" WHERE name = $1`,
      [name],
    );
    if (!source) throw new Error(`No ProductSource named "${name}"`);

    // Every table with a foreign key pointing at the source, so the report
    // covers whatever relations exist now rather than the ones I remembered.
    const referencing: { table_name: string; column_name: string }[] =
      await manager.query(
        `SELECT tc.table_name, kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND ccu.table_name = $1`,
        [sourceTable],
      );

    const counts: { table: string; column: string; rows: number }[] = [];
    for (const ref of referencing) {
      const [{ n }] = await manager.query(
        `SELECT COUNT(*)::int AS n FROM "${ref.table_name}" WHERE "${ref.column_name}" = $1`,
        [source.id],
      );
      counts.push({ table: ref.table_name, column: ref.column_name, rows: n });
    }

    // Versions are dumped too: they are the config's history, and restoring a
    // source at v1 when it was on v7 loses every earlier revision.
    const versionTable = referencing.find((r) =>
      r.table_name.includes('version'),
    );
    const versions = versionTable
      ? await manager.query(
          `SELECT * FROM "${versionTable.table_name}" WHERE "${versionTable.column_name}" = $1 ORDER BY version ASC`,
          [source.id],
        )
      : [];

    const lines: string[] = [];
    lines.push(`-- Revert: restores the ProductSource "${name}" (${source.id})`);
    lines.push(`-- Generated ${new Date().toISOString()} from the live row.`);
    lines.push('--');
    lines.push('-- Restores the SOURCE DEFINITION and its config history only.');
    lines.push('-- The rows below were attached at dump time and are NOT restored');
    lines.push('-- by this file — re-run the source to rebuild them:');
    for (const c of counts) {
      lines.push(`--   ${c.table}.${c.column}: ${c.rows} row(s)`);
    }
    lines.push('--');
    lines.push('-- The seller is referenced by id and must still exist.');
    lines.push('');
    lines.push('BEGIN;');
    lines.push('');
    lines.push(insertStatement(sourceTable, source));
    lines.push('');
    for (const version of versions) {
      lines.push(insertStatement(versionTable!.table_name, version));
    }
    if (versions.length) lines.push('');
    lines.push('COMMIT;');
    lines.push('');

    const resolved = path.resolve(outFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, lines.join('\n'));

    console.log(`Wrote ${resolved}`);
    console.log(`  source:   ${source.id} (type "${source.type}")`);
    console.log(`  versions: ${versions.length}`);
    console.log('  attached rows that a DELETE would destroy:');
    for (const c of counts) {
      console.log(`    ${c.table}.${c.column}: ${c.rows}`);
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
