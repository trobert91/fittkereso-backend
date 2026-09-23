/**
 * Enqueues the KTM e-bike catalog list pages for ebikeshop.hu, so a KTM catalog
 * can be built on demand without waiting for (or enabling) the source's cron
 * schedule.
 *
 * Why the pages are enumerated here rather than by the importer: this is a
 * BRAND-SCOPED run, which no source config expresses — a config's `startUrls`
 * cover the whole catalogue. `ScrapingImportService` does enumerate pages
 * properly for a real run (once per run, up front), so this script is for
 * narrow manual passes only, not a workaround for the importer.
 *
 * Each list page yields ~32 detail tasks, and every task is a paid Zyte fetch
 * plus an LLM post-process pass, rate limited to
 * `ProductSource.requestsPerHour`. Start small and widen.
 *
 * Usage (from the repo root):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=apps/product-collector/src/config/config.yaml \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/enqueue-ktm-catalog.ts \
 *     [--pages=N] [--from=N] [--source=ebikeshop|all]
 *
 * `--from` widens an already-scraped catalog without paying for the pages
 * already done: nothing dedupes list tasks, so re-running from page 1 refetches
 * every earlier page (the product links it finds are deduped, but the list
 * fetch itself is not).
 *
 * The tasks only run while the product-collector app is up (its poller claims
 * them every 5s) and while the source's `processingEnabled` is true.
 */
import { NestFactory } from '@nestjs/core';
import { ScrapeQueueName } from '@fittkereso-backend/database';
import { ScrapeTaskCreatorService } from '@fittkereso-backend/task';
import { AppModule } from '../src/app.module';

interface CatalogSource {
  name: string;
  /** Pages the KTM listing actually has — a run is capped to this. */
  totalPages: number;
  /** Page 1 is the bare URL; later pages carry the source's own page param. */
  urlOf: (page: number) => string;
}

// speedbike is gone from this list: it is FEED-ONLY now, and a feed cannot be
// scoped to one brand — it is the whole catalogue in one document, imported by
// a full sync rather than by enqueued list pages. Its filter URL was
// `index.php?route=filter&filter=category|1087/manufacturer|268` (1087 =
// E-BIKE, 268 = KTM) if a scraping source for it is ever recreated.
const SOURCES: CatalogSource[] = [
  {
    // ebikeshop's manufacturer page is already e-bikes only (the shop sells
    // nothing else), so it needs no category filter. 463 products, 32/page.
    name: 'ebikeshop',
    totalPages: 15,
    urlOf: (page) =>
      page === 1 ? 'https://ebikeshop.hu/ktm' : `https://ebikeshop.hu/ktm?oldal=${page}`,
  },
];

const DEFAULT_PAGES = 2;

function argValue(flag: string): string | undefined {
  return process.argv
    .find((arg) => arg.startsWith(`--${flag}=`))
    ?.split('=')[1];
}

async function bootstrap(): Promise<void> {
  const requestedPages = Number(argValue('pages') ?? DEFAULT_PAGES);
  if (!Number.isInteger(requestedPages) || requestedPages < 1) {
    throw new Error(`--pages must be a positive integer, got "${argValue('pages')}"`);
  }
  const from = Number(argValue('from') ?? 1);
  if (!Number.isInteger(from) || from < 1) {
    throw new Error(`--from must be a positive integer, got "${argValue('from')}"`);
  }
  const requestedSource = argValue('source') ?? 'all';
  const sources = SOURCES.filter(
    (source) => requestedSource === 'all' || source.name === requestedSource,
  );
  if (sources.length === 0) {
    throw new Error(
      `--source must be one of: all, ${SOURCES.map((s) => s.name).join(', ')}`,
    );
  }

  const app = await NestFactory.createApplicationContext(AppModule);
  const taskCreator = app.get(ScrapeTaskCreatorService);

  for (const source of sources) {
    // The source is resolved from the URL's domain, so a typo'd host fails
    // here rather than silently enqueueing against the wrong source.
    const pages = Math.min(requestedPages, source.totalPages);
    if (from > pages) {
      console.log(
        `\n${source.name}: nothing to do — --from=${from} is past page ${pages}`,
      );
      continue;
    }
    console.log(
      `\n${source.name}: enqueueing pages ${from}..${pages} of ${source.totalPages}`,
    );

    for (let page = from; page <= pages; page++) {
      const url = source.urlOf(page);
      try {
        const task = await taskCreator.create({
          queue: ScrapeQueueName.ScrapeProductList,
          url,
        });
        console.log(`  page ${page}: task ${task.id}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  page ${page}: FAILED — ${message}`);
      }
    }
  }

  await app.close();
  // The Nest context keeps handles open, so the script would otherwise sit
  // here after its work is done.
  process.exit(0);
}

bootstrap().catch((error) => {
  console.error('Enqueue failed:', error);
  process.exit(1);
});
