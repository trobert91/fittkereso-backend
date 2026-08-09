import { Injectable } from "@nestjs/common";
import * as cheerio from "cheerio";
import { Brand, ProductSource } from "@ebike-backend/database";
import { SourceConfigService } from "@ebike-backend/config";
import { ScraperService } from "@ebike-backend/scraper";
import { isEmpty } from "lodash";
import { CustomLogger } from "@ebike-backend/logger";

@Injectable()
export class DisplaySpecsIndexPageService {
  private readonly logger = new CustomLogger(DisplaySpecsIndexPageService.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly sourceConfigService: SourceConfigService,
  ) {}

  /**
   * Fetches the DisplaySpecifications homepage and extracts
   * brand links, matching them to existing Brand entities.
   */
  public async fetchBrandLinks(
    source: ProductSource,
    brands: Brand[],
  ): Promise<Record<string, string | null>> {
    const fullSyncStartUrl = this.sourceConfigService.getFullSyncStartUrl(
      source.type,
    );
    if (!fullSyncStartUrl) {
      throw new Error(
        "DisplaySpecs fullSyncStartUrl not configured in source config",
      );
    }
    const baseUrl = this.sourceConfigService.getBaseUrl(source.type)!;

    const html = await this.scraperService.getHtml(fullSyncStartUrl);

    const $ = cheerio.load(html);
    const brandDiv = $(".brand-listing-container-frontpage");

    if (!brandDiv.length) {
      throw new Error(
        "Could not find .brand-listing-container-frontpage in page",
      );
    }

    // Extract all brand links
    const brandLinks: Record<string, string> = {};
    brandDiv.find("a").each((_, element) => {
      const name = $(element).text().trim();
      const href = $(element).attr("href");
      if (name && href) {
        // Ensure href is absolute
        const absoluteUrl = href.startsWith("http")
          ? href
          : `${baseUrl}${href}`;
        brandLinks[name.toLowerCase()] = absoluteUrl;
      }
    });

    // Map existing brands to found URLs
    const results: Record<string, string | null> = {};
    for (const brand of brands) {
      const foundUrl = brandLinks[brand.name.toLowerCase()] ?? null;
      results[brand.name] = foundUrl;
    }

    this.logger.log(
      `Matched ${Object.values(results).filter(Boolean).length}/${brands.length} brands`,
    );

    return results;
  }
}
