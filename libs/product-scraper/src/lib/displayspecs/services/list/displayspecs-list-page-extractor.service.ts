import { Injectable } from "@nestjs/common";
import { ScrapeTask } from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import * as cheerio from "cheerio";
import { ListPageExtractor } from "../../../product-scraper/interfaces/list-page-extractor.interface";
import { WebLink } from "@ebike-backend/product";

@Injectable()
export class DisplayspecsListPageExtractor implements ListPageExtractor {
  private readonly logger = new CustomLogger(
    DisplayspecsListPageExtractor.name,
  );

  public getCategoryName(
    _task: ScrapeTask,
    _$: cheerio.CheerioAPI,
  ): string | undefined {
    void _task;
    void _$;
    return undefined;
  }

  public async getCategoryLinks(
    _task: ScrapeTask,
    _$: cheerio.CheerioAPI,
  ): Promise<WebLink[]> {
    void _task;
    void _$;
    // no category links exist on displayspecs list pages
    return [];
  }

  public async getProductLinks(
    task: ScrapeTask,
    $: cheerio.CheerioAPI,
  ): Promise<WebLink[]> {
    const links = this.findProductLinks(task, $);

    return this.filterLinks(links);
  }

  private filterLinks(links: WebLink[]): WebLink[] {
    const currentYear = new Date().getFullYear();
    const keepYears = [currentYear, currentYear - 1, currentYear - 2];

    const filtered = links.filter((link) => {
      const category = link.category;
      if (!category) {
        return false;
      }
      return keepYears.some((year) => category.includes(year.toString()));
    });

    this.logger.debug(
      `Filtered ${links.length} links down to ${filtered.length} (keeping ${keepYears.join(", ")} only)`,
    );
    return filtered;
  }

  private findProductLinks(task: ScrapeTask, $: cheerio.CheerioAPI): WebLink[] {
    const results: WebLink[] = [];

    $("header.section-header").each((_, headerEl) => {
      const category = $(headerEl).find("h1.header").text().trim();
      if (!category) {
        return;
      }

      const brand = category.split("-")[0].trim();

      const container = $(headerEl)
        .nextUntil("header.section-header")
        .filter(".model-listing-container-80")
        .first();

      if (!container.length) {
        this.logger.warn(
          `No product container found for category: ${category}`,
          { taskId: task.id, url: task.url, category },
        );
        return;
      }

      container.find('div[id^="model_"]').each((_, modelEl) => {
        const linkEl = $(modelEl).find("h3 a");
        const url = linkEl.attr("href");
        const title = linkEl.text().trim().split(" ").slice(1).join(" ");

        if (url && title) {
          results.push({ category, title: `${brand} ${title}`, url });
        }
      });
    });

    this.logger.debug(`Extracted ${results.length} product links.`);

    // TODO: remove after testing
    return results;
  }
}
