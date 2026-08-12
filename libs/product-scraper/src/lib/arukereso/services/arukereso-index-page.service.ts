import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { ProductSource } from '@fittkereso-backend/database';
import { SourceConfigService } from '@fittkereso-backend/config';
import { ScraperService } from '@fittkereso-backend/scraper';
import { isEmpty, uniq } from 'lodash';
import { CustomLogger } from '@fittkereso-backend/logger';
import { WebLink } from '@fittkereso-backend/product';

@Injectable()
export class ArukeresoIndexPageService {
  private readonly logger = new CustomLogger(ArukeresoIndexPageService.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly sourceConfigService: SourceConfigService,
  ) {}

  /**
   * Fetches the Arukereso index page and returns the category links whose
   * titles match any of the given `expectedTitles`.
   */
  public async fetchCategoryLinks(
    source: ProductSource,
    expectedTitles: string[],
  ): Promise<WebLink[]> {
    const fullSyncStartUrl = this.sourceConfigService.getFullSyncStartUrl(
      source.type,
    );
    if (!fullSyncStartUrl) {
      throw new Error(
        'Arukereso fullSyncStartUrl not configured in source config',
      );
    }

    if (isEmpty(expectedTitles)) {
      return [];
    }

    const html = await this.scraperService.getHtml(fullSyncStartUrl);
    const $ = cheerio.load(html);

    const normalizedExpected = new Set(
      uniq(expectedTitles.map((title) => title.toLowerCase())),
    );
    const matched = new Map<string, WebLink>();

    $('.all-categories .by-letter a').each((_, link) => {
      const title = $(link).clone().children().remove().end().text().trim();
      const url = $(link).attr('href')?.trim();

      if (!url || !title) return;

      const normalizedTitle = title.toLowerCase();
      if (!normalizedExpected.has(normalizedTitle)) return;
      if (matched.has(normalizedTitle)) return;

      matched.set(normalizedTitle, { title, url });
    });

    const categoryLinks = Array.from(matched.values());

    const missingTitles = expectedTitles.filter(
      (title) => !matched.has(title.toLowerCase()),
    );
    if (!isEmpty(missingTitles)) {
      this.logger.warn(
        `Arukereso index page did not contain expected category titles`,
        { source: source.name, missingTitles },
      );
    }

    if (isEmpty(categoryLinks)) {
      this.logger.warn(
        `No matching category links found for source: ${source.name}`,
      );
    } else {
      this.logger.debug(
        `Found ${categoryLinks.length} matching category links for ${source.name}`,
      );
    }

    return categoryLinks;
  }
}
