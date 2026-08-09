import { ScrapeTask } from "@ebike-backend/database";
import { ScrapedProduct } from "@ebike-backend/product";
import * as cheerio from "cheerio";

export interface ProductDetailsPageExtractor {
  extractProductDetails(
    task: ScrapeTask,
    $: cheerio.CheerioAPI,
  ): Promise<ScrapedProduct | null>;
}
