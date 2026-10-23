import {
  CategorySpecCoverage,
  FeedCheckResult,
  LastImportRun,
  ListingSample,
  PageSample,
  ReviewedListing,
  SourceReviewSummary,
} from '@fittkereso-backend/product-scraper';
import { ProductSource, ProductSpecs, ScrapedOffer } from '@fittkereso-backend/database';

/** Responses stay under this; a cut is noted where it happens. */
export const RESPONSE_LIMIT = 150_000;
const LABEL_ROWS_LIMIT = 80;

// ─── shared ────────────────────────────────────────────────────────────────

const pct = (count: number, total: number) =>
  total > 0 ? `${Math.round((count / total) * 100)}%` : '–';
const cell = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
/** A long raw or spec value, cut: a slice of 20 listings stays readable. */
const short = (text: string, limit = 100) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const value = (spec: ProductSpecs[string]) => short(Array.isArray(spec) ? spec.join(', ') : String(spec));

/** Cuts a response at the limit, saying so. */
export function capResponse(text: string): string {
  if (text.length <= RESPONSE_LIMIT) return text;
  return `${text.slice(0, RESPONSE_LIMIT)}\n\n_…cut at ${RESPONSE_LIMIT} characters: ask for a smaller slice or one category._`;
}

function sourceLine(source: ProductSource): string {
  return [
    `type ${source.type}`,
    `fetch ${source.fetchMode}`,
    `priority ${source.priority}`,
    source.identifiesProducts ? 'identifies products' : 'contributing (identifies no products)',
    source.hasAllProducts ? 'hasAllProducts' : null,
    `processing ${source.processingEnabled ? 'on' : 'off'}`,
    `scheduling ${source.schedulingEnabled ? 'on' : 'off'}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function lastRunLine(run: LastImportRun | null): string {
  if (!run) return '- **Last run:** none recorded';
  const payload = JSON.stringify(run.payload);
  return `- **Last run:** ${run.type} at ${new Date(run.occurredAt).toISOString()}: \`${payload.length > 600 ? `${payload.slice(0, 600)}…` : payload}\``;
}

// ─── get_shop_review_summary ───────────────────────────────────────────────

export function formatShopReviewSummary(summaries: SourceReviewSummary[], categorySlug?: string): string {
  const seller = summaries[0]?.source.seller;
  const L: string[] = [];
  L.push(`# Shop review summary: ${seller?.name ?? 'unknown seller'} (${seller?.id ?? '?'})`);
  L.push(
    `${summaries.length} source(s) · category: ${categorySlug ?? 'all'} · read from the database only (no fetch, no LLM)`,
  );
  L.push('');
  L.push(
    'Shares: listings = attached listings of the category; "Mapped" = deterministic specMapping (extractedSpecs), "After LLM" = the listing\'s specs, "Offer" = offer entries\' specs, "Product" = share of their products with the key from any seller.',
  );
  for (const summary of summaries) {
    L.push('');
    L.push(...formatSourceSummary(summary));
  }
  return capResponse(L.join('\n'));
}

function formatSourceSummary(summary: SourceReviewSummary): string[] {
  const { source } = summary;
  const L: string[] = [];
  L.push(`## ${source.name} (${source.id})`);
  L.push(`- ${sourceLine(source)}`);
  L.push(`- **Enabled categories:** ${summary.enabledCategories.join(', ') || 'none'}`);
  L.push(lastRunLine(summary.lastRun));
  L.push('');
  L.push('| Category | Listings | Attached | Products | specValid=false | identity_failed | identity_off | Page read | Page failed |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of summary.counts) {
    L.push(
      `| ${row.slug ?? '–'} | ${row.listings} | ${row.attached} | ${row.products} | ${row.specInvalid} | ${row.identityFailed} | ${row.identityOff} | ${row.pageRead} | ${row.pageFailed} |`,
    );
  }
  if (summary.counts.length === 0) L.push('| – | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');

  for (const coverage of summary.coverage) L.push('', ...formatCoverage(coverage));
  L.push('', ...formatSavedFields(summary));
  L.push('', ...formatSpecLabels(summary));
  if (summary.feedFields) L.push('', ...formatStoredFeedFields(summary.feedFields));
  return L;
}

function formatCoverage(coverage: CategorySpecCoverage): string[] {
  const L: string[] = [];
  L.push(`### Spec coverage: ${coverage.slug} (${coverage.listings} attached listings, ${coverage.products} products)`);
  if (coverage.keys.length === 0) {
    L.push('_The category has no schema._');
    return L;
  }
  const byKey = new Map(coverage.keys.map((key) => [key.key, key]));
  const tagged = (key: string) => {
    const tags = byKey.get(key)?.tags ?? [];
    return tags.length ? `${key} (${tags.join('/')})` : key;
  };
  L.push(`- **Never filled (${coverage.neverFilled.length}):** ${coverage.neverFilled.map(tagged).join(', ') || 'none'}`);
  L.push(
    `- **LLM-only, mapping candidates (${coverage.llmOnly.length}):** ${
      coverage.llmOnly
        .map((key) => {
          const entry = byKey.get(key);
          return `${tagged(key)} ${pct(entry?.extracted ?? 0, coverage.listings)} → ${pct(entry?.specs ?? 0, coverage.listings)}`;
        })
        .join(', ') || 'none'
    }`,
  );
  L.push('');
  L.push('| Key | Tags | Mapped | After LLM | Offer | Product |');
  L.push('|---|---|---|---|---|---|');
  for (const key of coverage.keys) {
    L.push(
      `| ${key.key} | ${key.tags.join(', ')} | ${pct(key.extracted, coverage.listings)} | ${pct(key.specs, coverage.listings)} | ${key.tags.includes('offer') ? `${pct(key.offer, coverage.listings)} | ` : ` | ${pct(key.product, coverage.products)}`} |`,
    );
  }
  return L;
}

function formatSavedFields(summary: SourceReviewSummary): string[] {
  const saved = summary.savedFields;
  const L: string[] = ['### Saved fields (all listings)'];
  if (!saved) {
    L.push('_No listings._');
    return L;
  }
  L.push(
    `- ${saved.listings} listings · images ${pct(saved.withImages, saved.listings)} (median ${saved.imagesMedian}) · description ${pct(saved.withDescription, saved.listings)} (median ${Math.round(saved.descriptionMedianLength)} chars) · aliases ${pct(saved.withAliases, saved.listings)} · declared siblings ${pct(saved.withSiblings, saved.listings)} · externalId ${pct(saved.withExternalId, saved.listings)}`,
  );
  L.push(`- ${saved.offerEntries} offer entries. "Not mapped" = the source never states the field; "mapped, null" = it maps it and this item has none.`);
  L.push('');
  L.push('| Offer field | Value | Mapped, null | Not mapped |');
  L.push('|---|---|---|---|');
  for (const field of saved.offerFields) {
    L.push(
      `| ${field.field} | ${pct(field.value, saved.offerEntries)} | ${pct(field.mappedNull, saved.offerEntries)} | ${pct(field.notMapped, saved.offerEntries)} |`,
    );
  }
  return L;
}

function formatSpecLabels(summary: SourceReviewSummary): string[] {
  const L: string[] = [];
  const slugs = [...new Set(summary.specLabels.map((row) => row.slug ?? '–'))];
  for (const slug of slugs) {
    const rows = summary.specLabels.filter((row) => (row.slug ?? '–') === slug);
    // A row a product-page pipeline reads (the release year from "Modellév") is read too.
    const notMapped = rows.filter((row) => row.reader !== 'mapped' && row.reader !== 'pipeline');
    L.push(
      `### Spec rows no mapping reads: ${slug} (${notMapped.length} of ${rows.length} labels; ${rows.length - notMapped.length} are mapped or read by a page pipeline)`,
    );
    if (notMapped.length === 0) {
      L.push('_Every label is mapped._');
      L.push('');
      continue;
    }
    L.push('"identity" = only the identity extraction reads it (identitySpecRows). The spec unification LLM still sees every row.');
    L.push('');
    L.push('| Label | Section | Read by | Listings | From page | Examples |');
    L.push('|---|---|---|---|---|---|');
    for (const row of notMapped.slice(0, LABEL_ROWS_LIMIT)) {
      L.push(
        `| ${cell(row.name)} | ${cell(row.sectionTitle ?? '')} | ${row.reader === 'identity' ? 'identity' : '–'} | ${row.count} | ${row.pageCount || ''} | ${cell(row.examples.join(' / '))} |`,
      );
    }
    if (notMapped.length > LABEL_ROWS_LIMIT) {
      L.push(`_…${notMapped.length - LABEL_ROWS_LIMIT} more labels, each on fewer listings, cut._`);
    }
    L.push('');
  }
  L.push('### Mappings no stored row matches (none of their labels)');
  if (summary.staleMappings.length === 0) L.push('_None._');
  for (const stale of summary.staleMappings) {
    L.push(
      `- ${stale.slug}: ${stale.key} ← ${stale.labels.map((label) => `"${label}"`).join(', ')}${stale.sectionTitle ? ` (section "${stale.sectionTitle}")` : ''}`,
    );
  }
  return L;
}

function formatStoredFeedFields(feed: NonNullable<SourceReviewSummary['feedFields']>): string[] {
  if (feed.origin === 'none') {
    return [
      '### Feed columns',
      '_No stored feed row (finished feed tasks may keep no payload) and no fresh feed snapshot: run check_product_source_feed for this source (one download), then call this again._',
    ];
  }
  const L: string[] = [
    feed.origin === 'stored'
      ? `### Feed columns (newest ${feed.rows} stored feed rows, one per listing)`
      : `### Feed columns (the ${feed.rows} eligible rows of the feed downloaded at ${feed.fetchedAt?.toISOString()})`,
  ];
  const unread = feed.fields.filter((field) => field.readers.length === 0 && field.filled > 0);
  const read = feed.fields.filter((field) => field.readers.length > 0);
  L.push(`- **Read by the config:** ${read.map((field) => `${field.name} (${field.readers.join(', ')})`).join('; ') || 'none'}`);
  L.push(`- **Empty on every row:** ${feed.fields.filter((field) => field.filled === 0).map((field) => field.name).join(', ') || 'none'}`);
  L.push('');
  L.push('No target reads these columns, so they never reach a listing:');
  L.push('');
  L.push('| Column | Filled | Examples |');
  L.push('|---|---|---|');
  for (const field of unread) {
    L.push(`| ${field.name} | ${pct(field.filled, feed.rows)} | ${cell(field.examples.join(' / '))} |`);
  }
  if (unread.length === 0) L.push('| – | – | – |');
  return L;
}

// ─── check_product_source_feed ─────────────────────────────────────────────

export function formatFeedCheck(result: FeedCheckResult): string {
  const { source, feed } = result;
  const L: string[] = [];
  L.push(`# Feed check: ${source.name} (${source.id})`);
  L.push(`- ${sourceLine(source)}`);
  L.push(lastRunLine(result.lastRun));
  L.push('');
  L.push('## Import tasks');
  if (result.taskStatus.length === 0) L.push('_None._');
  else {
    L.push('| Kind | Status | Tasks |');
    L.push('|---|---|---|');
    for (const row of result.taskStatus) L.push(`| ${row.kind} | ${row.status} | ${row.count} |`);
  }
  L.push('');
  if (!feed) {
    L.push('_A scraping source has no feed: only its import state is shown. sample_shop_pages reads its pages._');
    return capResponse(L.join('\n'));
  }

  const { snapshot } = feed;
  L.push(`## Feed: ${snapshot.url}`);
  if (!snapshot.reachable) {
    L.push(`- **Not readable:** ${snapshot.error ?? 'unknown error'} (after ${snapshot.totalMs ?? 0} ms)`);
    return capResponse(L.join('\n'));
  }
  L.push(
    `- ${((snapshot.bytes ?? 0) / 1_000_000).toFixed(1)} MB · ${snapshot.format} · response opened after ${snapshot.openMs} ms, first byte ${snapshot.firstByteMs ?? '?'} ms, read in ${snapshot.totalMs} ms · kept for 60 minutes: sample_shop_listings reads each listing's row from it`,
  );
  L.push(
    `- **${snapshot.rows} rows, ${snapshot.eligible.length} pass the gate** (filter, then the category rules)${feed.maxItems ? ` · the config caps a run at maxItems ${feed.maxItems}, so many new listings are expected` : ''}`,
  );
  L.push('');
  L.push('| Outcome | Rows |');
  L.push('|---|---|');
  for (const [outcome, count] of Object.entries(snapshot.outcomes).sort((a, b) => b[1] - a[1])) {
    L.push(`| ${outcome} | ${count} |`);
  }
  L.push('');
  L.push(
    `- **Repeated listing ids:** ${feed.repeatedIdTotal}${feed.repeatedIds.length ? ` (${feed.repeatedIds.map((entry) => `${entry.id} ×${entry.rows}`).join(', ')})` : ''}. A run keeps one row per id.`,
  );
  L.push(`- **New listings** (eligible rows with no record): ${feed.newListings.total}${feed.newListings.examples.length ? ` · e.g. ${feed.newListings.examples.join(', ')}` : ''}`);
  L.push(
    `- **Delisted** (records no eligible row names): ${feed.delisted.total}, ${feed.delisted.attached} of them attached${feed.delisted.examples.length ? ` · e.g. ${feed.delisted.examples.join(', ')}` : ''}`,
  );
  L.push(
    feed.fieldChanges.storedRows > 0
      ? `- **Columns vs the newest ${feed.fieldChanges.storedRows} stored rows:** appeared ${feed.fieldChanges.appeared.join(', ') || 'none'} · vanished ${feed.fieldChanges.vanished.join(', ') || 'none'}`
      : '- **Columns vs stored rows:** nothing stored yet to compare with',
  );
  L.push('');
  L.push(`## Columns of the ${snapshot.eligible.length} eligible rows`);
  L.push('| Column | Filled | Read by | Example |');
  L.push('|---|---|---|---|');
  for (const field of feed.fields) {
    L.push(`| ${field.name} | ${pct(field.filled, snapshot.eligible.length)} | ${field.readers.join(', ') || '–'} | ${cell((field.examples[0] ?? '').slice(0, 80))} |`);
  }
  return capResponse(L.join('\n'));
}

// ─── sample_shop_listings ──────────────────────────────────────────────────

export function formatListingSample(sample: ListingSample, limit: number): string {
  const L: string[] = [];
  const { source } = sample;
  L.push(`# Listings of ${source.name} (${source.id}): ${sample.offset + 1}–${sample.offset + sample.listings.length} of ${sample.total}`);
  L.push(
    `Ordered by product publicId (stable), unattached last. Next slice: offset ${sample.offset + limit}. Specs: [d] deterministic mapping · [llm] filled by the LLM · [llm≠d] the LLM replaced the mapped value. Rows: "mapped" a specMapping reads it · "pipeline" a product-page pipeline reads it · "identity" only the identity extraction · "unread" no rule. Feed columns: only the ones no target reads, with the count of read ones.`,
  );
  if (sample.feedRows) {
    const rows = sample.feedRows;
    L.push(
      `Feed rows: ${rows.stored} stored, ${rows.snapshot} from the feed downloaded at ${rows.snapshotFetchedAt?.toISOString() ?? '–'}, ${rows.missing} missing${rows.missing ? ' (no stored row and no kept feed snapshot with that id: pass feedRows "live", or the listing left the feed)' : ''}.`,
    );
  }
  sample.listings.forEach((listing, index) => {
    L.push('');
    L.push(...formatListing(listing, sample.offset + index + 1));
  });
  if (sample.listings.length === 0) L.push('', '_No listings in this slice._');
  return capResponse(L.join('\n'));
}

function formatListing(listing: ReviewedListing, position: number): string[] {
  const L: string[] = [];
  const product = listing.product;
  L.push(
    `### ${position}. ${product ? `p${product.publicId} · ${product.name}` : 'unattached'} (${listing.category ?? 'no category'})`,
  );
  L.push(
    `- **Listing:** "${listing.title ?? ''}" · ${listing.url ?? 'no url'} · externalId ${listing.externalId ?? '–'} · model "${listing.model ?? '–'}" · flags ${listing.flags.join(', ') || 'none'}${listing.specValid ? '' : ' · specValid=false'}`,
  );
  L.push(
    `- **Specs:** ${
      listing.specs
        .map((spec) => {
          if (spec.origin === 'd') return `${spec.key}=${value(spec.value)}[d]`;
          if (spec.origin === 'llm') return `${spec.key}=${value(spec.value)}[llm]`;
          return `${spec.key}=${value(spec.value)}[llm≠d ${value(spec.deterministic)}]`;
        })
        .join('; ') || 'none'
    }`,
  );
  if (product) {
    if (product.otherSellers.length) {
      L.push(`- **Product has from other sellers:** ${product.otherSellers.map((spec) => `${spec.key}=${value(spec.value)}`).join('; ')}`);
    }
    L.push(`- **Product lacks:** ${product.missingKeys.join(', ') || 'nothing'}`);
  }
  for (const reader of ['mapped', 'pipeline', 'identity', 'unread'] as const) {
    const rows = listing.rawRows.filter((row) => row.reader === reader);
    if (rows.length === 0) continue;
    L.push(
      `- **Rows, ${reader}:** ${rows
        .map((row) => `${row.sectionTitle ? `${row.sectionTitle} › ` : ''}${row.name}${row.origin === 'page' ? ' [page]' : ''} = ${short(row.values.join(' | '))}`)
        .join('; ')}`,
    );
  }
  if (listing.rawRows.length === 0) L.push('- **Rows:** none');
  if (listing.feedFields) {
    const unread = listing.feedFields.filter((field) => field.readers.length === 0);
    L.push(
      `- **Feed columns no target reads** (${listing.feedFields.length - unread.length} read): ${unread.map((field) => `${field.name}=${field.value}`).join('; ') || 'none'}`,
    );
  }
  L.push(
    listing.description
      ? `- **Description** (${listing.descriptionLength} chars): ${listing.description.replace(/\s+/g, ' ')}`
      : '- **Description:** none',
  );
  L.push(`- **Images:** ${listing.images}`);
  listing.offers.forEach((offer, index) => L.push(`- **Offer ${index + 1}:** ${offerLine(offer)}`));
  return L;
}

function offerLine(offer: ScrapedOffer): string {
  const field = (name: string, raw: unknown) =>
    raw === undefined ? `${name} –` : raw === null ? `${name} null` : `${name} ${raw}`;
  return [
    `${offer.price} ${offer.currency ?? ''}`.trim(),
    field('old', offer.priceWithoutDiscount),
    field('availability', offer.availability),
    field('condition', offer.condition),
    field('gtin', offer.gtin),
    field('mpn', offer.mpn),
    offer.externalId ? `id ${offer.externalId}` : null,
    offer.specs && Object.keys(offer.specs).length
      ? `specs ${Object.entries(offer.specs)
          .map(([key, spec]) => `${key}=${value(spec)}`)
          .join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ─── sample_shop_pages ─────────────────────────────────────────────────────

export function formatPageSample(sample: PageSample, limit: number): string {
  const { source } = sample;
  const L: string[] = [];
  L.push(`# Product pages of ${source.name} (${source.id}), read now`);
  if (sample.unavailable) {
    L.push('', `_${sample.unavailable}_`);
    return capResponse(L.join('\n'));
  }
  L.push(
    `Listings ${sample.offset + 1}–${sample.offset + sample.pages.length} of ${sample.total}, in sample_shop_listings' order. Next slice: offset ${sample.offset + limit}. Each page: its visible text, then what the detailPage pipelines extracted from the same HTML. Text the extraction does not hold is what the selectors miss.`,
  );
  for (const page of sample.pages) {
    L.push('');
    L.push(`## ${page.publicId ? `p${page.publicId} · ` : ''}${page.title ?? page.url}`);
    L.push(`- ${page.url}${page.fetchMode ? ` · fetched ${page.fetchMode}, ${page.htmlLength} bytes of HTML` : ''}`);
    if (page.error) {
      L.push(`- **Not read:** ${page.error}`);
      continue;
    }
    const detail = page.detail;
    if (detail) {
      L.push(
        `- **Extracted:** brand ${detail.brand ?? '–'} · model ${detail.model ?? '–'} · category ${detail.categorySlug ?? '–'} · externalId ${detail.externalId ?? '–'} · release year ${detail.releaseYear ?? '–'} · siblings ${detail.siblingIds?.length ?? 0} · images ${detail.imageUrls.length} · description ${detail.description?.length ?? 0} chars`,
      );
      L.push(
        `- **Rows (${detail.rawSpecs.length}):** ${
          detail.rawSpecs
            .map((row) => `${row.sectionTitle ? `${row.sectionTitle} › ` : ''}${row.name} = ${short((row.values ?? []).join(' | '))}`)
            .join('; ') || 'none'
        }`,
      );
      detail.rawOffers.forEach((offer, index) =>
        L.push(`- **Offer ${index + 1}:** ${short(JSON.stringify(offer), 300)}`),
      );
    }
    L.push(`- **Page text** (${page.textLength ?? 0} chars):`);
    L.push('', '```text', page.text ?? '', '```');
  }
  return capResponse(L.join('\n'));
}
