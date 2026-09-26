import { Body, Controller, Post } from '@nestjs/common';
import { ScraperService } from '@fittkereso-backend/scraper';
import {
  DEFAULT_PRODUCT_SOURCE_FETCH_MODE,
  isProductSourceFetchMode,
} from '@fittkereso-backend/database';

@Controller('scrape-test')
export class ScrapeTestController {
  constructor(private readonly scraperService: ScraperService) {}

  @Post()
  async scrapeTest(@Body() body: { url: string; fetchMode?: string }) {
    const fetchMode = isProductSourceFetchMode(body.fetchMode)
      ? body.fetchMode
      : DEFAULT_PRODUCT_SOURCE_FETCH_MODE;
    const html = await this.scraperService.getHtml(body.url, fetchMode);
    return { message: 'Scrape test endpoint', url: body.url, fetchMode, html };
  }
}
