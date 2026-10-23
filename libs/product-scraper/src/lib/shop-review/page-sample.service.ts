import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  ProductImportTask,
  ProductSource,
  ProductSourceFetchMode,
  ProductSourceRecordReviewRepository,
  isArukeresoConfig,
  isScrapingConfig,
  pageFetchModeOf,
} from '@fittkereso-backend/database';
import { DetailPageResult, DetailPageSourceConfig } from '@fittkereso-backend/scrape-interpreter';
import { htmlToText } from '@fittkereso-backend/utils';
import { ProductPageReaderService } from '../product-scraper/services/product-page-reader.service';

export const PAGE_SAMPLE_MAX = 10;
const PAGE_TEXT_LIMIT = 5000;

/** One listing's product page, read now, next to what the pipelines took from it. */
export interface SampledPage {
  recordId: string;
  publicId: number | null;
  title: string | null;
  url: string;
  fetchMode?: ProductSourceFetchMode;
  htmlLength?: number;
  /** The page's visible text, cut at PAGE_TEXT_LIMIT characters. */
  text?: string;
  textLength?: number;
  detail?: DetailPageResult;
  error?: string;
}

export interface PageSample {
  source: ProductSource;
  total: number;
  offset: number;
  /** Why no page was read, for a source that has none to read. */
  unavailable?: string;
  pages: SampledPage[];
}

/**
 * Reads a slice of a source's listings' product pages now (the same slice
 * order as sample_shop_listings) and returns each page's visible text beside
 * what its detailPage pipelines extracted from the same HTML: what the page
 * says that no selector captures. One fetch per page, in the page's fetch mode
 * (Zyte unless direct). No spec mapping, no LLM call, nothing written.
 */
@Injectable()
export class PageSampleService {
  constructor(
    private readonly reviewRepo: ProductSourceRecordReviewRepository,
    private readonly pageReader: ProductPageReaderService,
  ) {}

  async sample(params: {
    source: ProductSource;
    categorySlug?: string;
    offset: number;
    limit: number;
  }): Promise<PageSample> {
    const { source } = params;
    const config = pageConfigOf(source);
    const result: PageSample = { source, total: 0, offset: params.offset, pages: [] };
    if (!config) {
      result.unavailable =
        'This feed source reads no product pages (no detailPage in its config): its listings are its feed rows.';
      return result;
    }
    const { total, records } = await this.reviewRepo.listingSlice({
      sourceId: source.id,
      categorySlug: params.categorySlug,
      offset: params.offset,
      limit: Math.min(params.limit, PAGE_SAMPLE_MAX),
    });
    result.total = total;
    const fetchMode = pageFetchModeOf(source, config.detailPage);

    // One page after another: a review's fetches stay as gentle as a run's.
    for (const record of records) {
      const scraped = record.scrapedProduct ?? {};
      const url = scraped.page?.url ?? record.url;
      const page: SampledPage = {
        recordId: record.id,
        publicId: record.product?.publicId ?? null,
        title: scraped.originalName ?? record.originalTitle ?? null,
        url: url ?? '',
      };
      if (!url) {
        page.error = 'The listing has no URL.';
        result.pages.push(page);
        continue;
      }
      try {
        const read = await this.pageReader.interpret({
          task: {
            url,
            force: true,
            source: { id: source.id, name: source.name, fetchMode, config: source.config },
          } as unknown as ProductImportTask,
          config,
          // A feed listing's page is read for the category its row brought.
          category: isArukeresoConfig(source.config) ? scraped.category : undefined,
          keepHtml: true,
        });
        const text = htmlToText(mainContent(read.html ?? ''));
        page.fetchMode = read.fetchMode;
        page.htmlLength = read.htmlLength;
        page.textLength = text.length;
        page.text = text.length > PAGE_TEXT_LIMIT ? `${text.slice(0, PAGE_TEXT_LIMIT)}…` : text;
        page.detail = read.detail;
      } catch (error: unknown) {
        page.error = error instanceof Error ? error.message : String(error);
      }
      result.pages.push(page);
    }
    return result;
  }
}

/** Elements that carry no product content: menus, headers, footers, scripts. */
const CHROME = 'script, style, noscript, template, svg, nav, header, footer, [role="navigation"], [aria-hidden="true"]';
/** Where a product page's own content usually sits, most specific first. */
const CONTENT = ['main', '[itemtype*="schema.org/Product"]', '#content', 'article'];
/** A container with less text than this is not the page's content. */
const MIN_CONTENT_CHARS = 500;

/**
 * The page's own content as HTML: the menus, header and footer dropped, and
 * the main content element kept when the page has one, so the text limit is
 * spent on the product rather than on the shop's navigation.
 */
export function mainContent(html: string): string {
  const $ = cheerio.load(html);
  $(CHROME).remove();
  for (const selector of CONTENT) {
    const found = $(selector).first();
    if (found.length && found.text().trim().length >= MIN_CONTENT_CHARS) return $.html(found);
  }
  return $('body').html() ?? html;
}

/** The config a source reads its product pages with, or none for a feed without a detailPage. */
function pageConfigOf(source: ProductSource): DetailPageSourceConfig | undefined {
  const config = source.config;
  if (isScrapingConfig(config)) return config as unknown as DetailPageSourceConfig;
  if (isArukeresoConfig(config) && config.detailPage) {
    return { baseUrl: config.baseUrl, categories: config.categories, detailPage: config.detailPage };
  }
  return undefined;
}
