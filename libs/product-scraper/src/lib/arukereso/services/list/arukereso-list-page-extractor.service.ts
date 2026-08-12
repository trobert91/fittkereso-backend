import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { CustomLogger } from '@fittkereso-backend/logger';
import { chain } from 'lodash';
import { ScrapeTask } from '@fittkereso-backend/database';
import { ListPageExtractor } from '../../../product-scraper/interfaces/list-page-extractor.interface';
import { BrandCacheService, WebLink } from '@fittkereso-backend/product';

@Injectable()
export class ArukeresoListPageExtractor implements ListPageExtractor {
  private readonly logger = new CustomLogger(ArukeresoListPageExtractor.name);

  constructor(private readonly brandCacheService: BrandCacheService) {}

  public getCategoryName(task: ScrapeTask, $: cheerio.CheerioAPI): string {
    const categoryName = $('h1.category-title').first().text().trim();
    return categoryName || '';
  }

  /**
   * Fetches the Arukereso index page and extracts category links
   * defined in config.categoriesToParse.
   */
  public async getProductLinks(
    task: ScrapeTask,
    $: cheerio.CheerioAPI,
  ): Promise<WebLink[]> {
    const results: WebLink[] = [];

    const productBoxes = $('.list-view .product-box');

    this.logger.debug(
      `Found ${productBoxes.length} product boxes on the page.`,
      { taskId: task.id, url: task.url },
    );
    // Each .product-box in .list-view may or may not be a real product
    $('.list-view .product-box').each((_, el) => {
      const $box = $(el);
      const productId = $box.attr('data-akpid');

      // Skip if no data-akpid or ends with "-PADS"
      if (!productId || productId.endsWith('-PADS')) {
        return;
      }

      // Try to extract the product name and link
      // Usually inside: .name h2 a OR top image a.image
      // Find the first valid <a> link (ignoring Jump.php links)
      const linkEl = $box
        .find('a')
        .filter((_, a) => {
          const href = $(a).attr('href');
          return !!href && !href.includes('Jump.php');
        })
        .first();

      const url = chain(linkEl.attr('href'))
        .trim()
        .trimEnd('/')
        .value()
        .concat('/#termek-leiras');
      const title = linkEl.attr('title')?.trim() || linkEl.text().trim();

      if (url && title) {
        results.push({
          url,
          title,
        });
      }
    });

    this.logger.debug(`Extracted ${results.length} product links.`, {
      taskId: task.id,
      url: task.url,
    });

    const brands = await this.brandCacheService.getCachedBrands();
    const brandNames = brands.map((brand) => brand.name.toLowerCase());

    const filtered = results.filter((link) => {
      const titleLower = link.title.toLowerCase();
      return brandNames.some((brandName) => titleLower.startsWith(brandName));
    });

    this.logger.debug(
      `Brand filter: kept ${filtered.length} of ${results.length} product links.`,
      { taskId: task.id, url: task.url },
    );

    return filtered;
  }

  public async getCategoryLinks(
    task: ScrapeTask,
    $: cheerio.CheerioAPI,
  ): Promise<WebLink[]> {
    const links: WebLink[] = [];

    const productNumText = $('.category-navbar .product-num').text().trim();

    // Only proceed if we're on the first page
    if (!productNumText.includes(', 1. oldal')) {
      return links;
    }

    // Extract product count (e.g. "2886 termék" -> 2886)
    const match = productNumText.match(/(\d+)\s*termék/);
    if (!match) {
      this.logger.warn('Could not parse product number from category-navbar.', {
        taskId: task.id,
        url: task.url,
      });
      return links;
    }

    const totalProducts = parseInt(match[1], 10);
    const perPage = 25;
    const totalPages = Math.ceil(totalProducts / perPage);

    this.logger.debug(
      `Detected ${totalProducts} total products -> ${totalPages} pages.`,
      { taskId: task.id, url: task.url },
    );

    const baseUrl = chain(task.url).split('?').head().trimEnd('/').value();
    if (!baseUrl) {
      this.logger.warn('Base URL not found for pagination generation.', {
        taskId: task.id,
        url: task.url,
      });
      return links;
    }

    // Generate paginated links
    for (let i = 1; i < totalPages; i++) {
      const start = i * perPage;
      const url = `${baseUrl}/?start=${start}`;
      links.push({ url, title: `Page ${i + 1}` });
    }

    this.logger.debug(`Generated ${links.length} paginated links.`, {
      taskId: task.id,
      url: task.url,
    });
    return links;
  }
}
