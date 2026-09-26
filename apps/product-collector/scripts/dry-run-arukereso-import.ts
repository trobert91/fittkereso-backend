/**
 * Reports what an Árukereső source's next run WOULD do, without writing a row
 * or spending a token.
 *
 * Runs the real mapper — field addressing, the category gate, deterministic
 * spec extraction, the two hashes — against the live feed. The mapper makes no
 * LLM call (the updater decides which listings need one), so nothing here costs
 * money, and nothing it skips could change which items are imported or what
 * they are keyed on.
 *
 * What it is for: a feed is the whole catalogue in one document, so the cost of
 * a mistake is the whole catalogue. The two questions it answers before a first
 * real run are "how many items survive the category gate" and "is the chosen
 * externalId actually unique" — the second silently collapses offers onto one
 * row if it is wrong, and Offer is @Unique([seller, externalId]).
 *
 * Usage (from fittkereso-backend/):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=apps/product-collector/src/config/config.yaml \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/dry-run-arukereso-import.ts <source-name> [limit]
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  asArukeresoConfig,
  ProductSourceRepository,
} from '@fittkereso-backend/database';
import { ScraperService } from '@fittkereso-backend/scraper';
import {
  ArukeresoFeedParserService,
  ArukeresoProductMapperService,
  FeedSkipReason,
} from '@fittkereso-backend/product-scraper';

async function main(): Promise<void> {
  const [name, limitArg] = process.argv.slice(2);
  if (!name) {
    console.error('Usage: dry-run-arukereso-import.ts <source-name> [limit]');
    process.exit(1);
  }
  const limit = limitArg ? Number(limitArg) : Infinity;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  try {
    const source = await app
      .get(ProductSourceRepository)
      .findOne({ where: { name }, relations: ['seller'] });
    if (!source) throw new Error(`No ProductSource named "${name}"`);

    const config = asArukeresoConfig(source.config, source.name);

    const mapper = app.get(ArukeresoProductMapperService);

    const skips: Partial<Record<FeedSkipReason, number>> = {};
    const externalIds = new Map<string, number>();
    const specKeyCounts = new Map<string, number>();
    const samples: unknown[] = [];
    let mapped = 0;
    let seen = 0;
    let withoutExternalId = 0;
    let specKeyTotal = 0;

    // In the source's own fetch mode, as its run would fetch it.
    const { stream, contentType } = await app
      .get(ScraperService)
      .stream(config.feedUrl, source.fetchMode);

    const started = Date.now();
    const summary = await app.get(ArukeresoFeedParserService).parseStream(
      stream,
      async (item) => {
        seen += 1;
        if (seen > limit) return;

        const result = await mapper.map({ config, item });
        if (result.status === 'skipped') {
          skips[result.reason] = (skips[result.reason] ?? 0) + 1;
          return;
        }

        mapped += 1;
        const product = result.scrapedProduct;

        const externalId = product.externalId;
        if (!externalId) withoutExternalId += 1;
        else externalIds.set(externalId, (externalIds.get(externalId) ?? 0) + 1);

        const keys = Object.keys(product.extractedSpecs ?? {});
        specKeyTotal += keys.length;
        for (const key of keys) {
          specKeyCounts.set(key, (specKeyCounts.get(key) ?? 0) + 1);
        }

        if (samples.length < 3) {
          samples.push({
            externalId,
            brand: product.brand,
            originalName: product.originalName,
            url: result.url,
            price: product.offers?.[0]?.price,
            currency: product.offers?.[0]?.currency,
            availability: product.offers?.[0]?.availability,
            specKeys: keys.length,
            offerSpecsHash: product.offerSpecsHash?.slice(0, 12),
            productSpecsHash: product.productSpecsHash?.slice(0, 12),
          });
        }
      },
      {
        format: config.format ?? 'auto',
        delimiter: config.csv?.delimiter ?? 'auto',
        contentType,
      },
    );

    const duplicates = [...externalIds.entries()].filter(([, n]) => n > 1);

    console.log('\n=== Dry run: %s ===', source.name);
    console.log('feed            : %s', config.feedUrl);
    console.log('format          : %s', summary.format);
    console.log('items parsed    : %d', summary.itemsParsed);
    console.log('attrs dropped   : %d', summary.attributesSkipped);
    console.log('duration        : %ds', Math.round((Date.now() - started) / 1000));
    console.log('\nwould import    : %d', mapped);
    console.log('would skip      : %d', Object.values(skips).reduce((a, b) => a + b, 0));
    for (const [reason, count] of Object.entries(skips).sort((a, b) => b[1] - a[1])) {
      console.log('  %s: %d', reason.padEnd(26), count);
    }

    console.log('\nidentity');
    console.log('  distinct externalIds : %d', externalIds.size);
    console.log('  items with none      : %d (URL-slug fallback)', withoutExternalId);
    // The check this script exists for. A non-zero count here means offers WILL
    // collapse onto one row per duplicated id, losing every one but the last.
    console.log('  DUPLICATED ids       : %d', duplicates.length);
    for (const [id, count] of duplicates.slice(0, 10)) {
      console.log('    %s x%d', id, count);
    }

    console.log('\ndeterministic specs');
    console.log('  avg keys per product : %s', (specKeyTotal / (mapped || 1)).toFixed(1));
    const topKeys = [...specKeyCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log('  keys populated       : %d', topKeys.length);
    for (const [key, count] of topKeys.slice(0, 15)) {
      console.log('    %s %d', key.padEnd(24), count);
    }

    console.log('\nsamples');
    for (const sample of samples) console.log(' ', JSON.stringify(sample));
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
