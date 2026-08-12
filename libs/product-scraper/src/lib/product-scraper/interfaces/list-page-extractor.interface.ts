import * as cheerio from 'cheerio';
import { ScrapeTask } from '@fittkereso-backend/database';
import { WebLink } from '@fittkereso-backend/product';

export interface ListPageExtractor {
  getCategoryName(task: ScrapeTask, $: cheerio.CheerioAPI): string | undefined;
  getCategoryLinks(task: ScrapeTask, $: cheerio.CheerioAPI): Promise<WebLink[]>;
  getProductLinks(task: ScrapeTask, $: cheerio.CheerioAPI): Promise<WebLink[]>;
}
