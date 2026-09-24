import type { CheerioAPI, Cheerio } from 'cheerio';
import type { ProductImportTask } from '@fittkereso-backend/database';
import type { RuntimeDataProvider } from './runtime-data-provider.interface';

// A pipeline value is either a plain scalar/array result, or a live Cheerio
// selection (kept around so a later op in the same pipeline can query it
// further, e.g. selectAll -> filterByAttrAbsent -> extractLinkFromBox).
export type PipelineValue = unknown;

export interface ScrapeExecutionContext {
  $: CheerioAPI;
  html: string;
  task: ProductImportTask;
  vars: Record<string, PipelineValue>;
  runtime: RuntimeDataProvider;
  // Extra named inputs supplied by the calling service for this run only
  // (e.g. { sourceTitles: [...] } for discovery, { brandNames: [...] } for
  // DisplaySpecs discovery). Referenced by ops like filterByAllowlist via
  // `against`.
  opts: Record<string, unknown>;
}

export type CheerioSelection = Cheerio<any>;
