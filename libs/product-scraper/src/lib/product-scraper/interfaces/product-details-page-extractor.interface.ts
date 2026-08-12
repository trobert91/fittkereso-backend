import { ScrapeTask } from '@fittkereso-backend/database';
import { ScrapedProduct } from '@fittkereso-backend/product';
import * as cheerio from 'cheerio';

export interface ProductDetailsPageExtractor {
  extractProductDetails(
    task: ScrapeTask,
    $: cheerio.CheerioAPI,
  ): Promise<ScrapedProduct | null>;
}
