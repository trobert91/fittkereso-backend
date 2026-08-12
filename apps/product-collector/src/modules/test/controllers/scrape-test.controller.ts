import { Body, Controller, Post } from '@nestjs/common';
import { ScraperService } from '@fittkereso-backend/scraper';

@Controller('scrape-test')
export class ScrapeTestController {
  constructor(private readonly scraperService: ScraperService) {}

  @Post()
  async scrapeTest(@Body() body: { url: string }) {
    const html = await this.scraperService.getHtml(body.url);
    return { message: 'Scrape test endpoint', url: body.url, html };
  }
}
