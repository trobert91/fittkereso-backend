import { Injectable } from "@nestjs/common";
import { ProductSourceType, ScrapeTask } from "@ebike-backend/database";
import {
  CategoryConfigService,
  SourceConfigService,
} from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import { ProductScrapingMetricsService } from "@ebike-backend/metrics";
import {
  ScrapedProduct,
  ScrapedProductSpec,
  SpecExtractionService,
} from "@ebike-backend/product";
import * as cheerio from "cheerio";
import { chain } from "lodash";
import { DisplayspecsCategoryMapperService } from "./displayspecs-category-mapper.service";
import { ProductDetailsPageExtractor } from "../../../product-scraper/interfaces/product-details-page-extractor.interface";
import { ProductValueMapperService } from "../../../product-scraper/services/product-value-mapper.service";

@Injectable()
export class DisplayspecsDetailsPageExtractor implements ProductDetailsPageExtractor {
  private readonly logger = new CustomLogger(
    DisplayspecsDetailsPageExtractor.name,
  );

  constructor(
    private readonly categoryMapper: DisplayspecsCategoryMapperService,
    private readonly productValueMapper: ProductValueMapperService,
    private readonly specExtraction: SpecExtractionService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly sourceConfigService: SourceConfigService,
    private readonly scrapingMetrics: ProductScrapingMetricsService,
  ) {}

  public async extractProductDetails(
    task: ScrapeTask,
    $: cheerio.CheerioAPI,
  ): Promise<ScrapedProduct | null> {
    const extractedSpecs = this.extractSpecifications($);

    const mainProperties = await this.extractMainProperties($, extractedSpecs);
    if (!mainProperties) {
      this.logger.warn(
        "Skipping product — missing required specs (Brand or Model)",
        { taskId: task.id, url: task.url },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        ProductSourceType.displaySpecs,
        "missing_brand_or_model",
      );
      return null;
    }

    const category = mainProperties.category;

    const enabledCategories = this.sourceConfigService.getEnabledCategorySlugs(
      ProductSourceType.displaySpecs,
    );
    if (!enabledCategories.includes(category.slug)) {
      this.logger.debug(
        `Skipping product — category '${category.slug}' not enabled for displayspecs`,
        { taskId: task.id, url: task.url },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        ProductSourceType.displaySpecs,
        "category_not_enabled",
      );
      return null;
    }
    const sourceConfig = category.slug
      ? this.categoryConfigService.getSpecMappingsForSource(
          category.slug,
          ProductSourceType.displaySpecs,
        )
      : undefined;
    const jsonSchema = category.slug
      ? this.categoryConfigService.getJsonSchema(category.slug)
      : undefined;

    const specs =
      sourceConfig && jsonSchema
        ? this.specExtraction.extractSpecs({
            scrapedSpecs: extractedSpecs,
            schema: jsonSchema,
            sourceConfig,
          })
        : {};

    return {
      ...mainProperties,
      specs,
    } as ScrapedProduct;
  }

  private async extractMainProperties(
    $: cheerio.CheerioAPI,
    extractedSpecs: ScrapedProductSpec[],
  ): Promise<ScrapedProduct | null> {
    const category = await this.categoryMapper.getCategory(extractedSpecs);

    const brand = this.productValueMapper.mapSingleValue({
      specs: extractedSpecs,
      label: "Brand",
    });
    const model = this.productValueMapper.mapSingleValue({
      specs: extractedSpecs,
      label: "Model",
    });

    if (!brand || !model) {
      return null;
    }
    const aliases = this.productValueMapper.mapListValue({
      specs: extractedSpecs,
      label: "Model alias",
    });
    const filteredAliases = aliases
      ? chain(aliases)
          .filter((alias) => alias.toLowerCase() !== model.toLowerCase())
          .uniq()
          .value()
      : undefined;

    const year = this.productValueMapper.mapNumber({
      specs: extractedSpecs,
      label: "Model year",
    });

    return {
      category,
      brand,
      model,
      displayName: `${brand} ${model}`.trim(),
      aliases: filteredAliases,
      releaseYear: year,
    };
  }

  private extractSpecifications($: cheerio.CheerioAPI): ScrapedProductSpec[] {
    const specs: ScrapedProductSpec[] = [];

    // Find all section headers
    $("header.section-header").each((_, header) => {
      const sectionTitle = $(header).find("h2.header").text().trim();
      // Find the next table after this header
      const nextTable = $(header)
        .nextAll("table.model-information-table")
        .first();

      if (!nextTable.length) return;

      nextTable.find("tbody > tr").each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length < 2) return;

        const nameCell = $(cells[0]);
        const valueCell = $(cells[1]);

        const name = nameCell
          .clone()
          .children("p")
          .remove()
          .end()
          .text()
          .trim();

        const description = nameCell.find("p").text().trim() || undefined;

        const rawValueHtml = valueCell.html() || "";
        const valueText = valueCell.text().trim();

        // Split on <br> and clean each value
        const values = rawValueHtml
          .split(/<br\s*\/?>/i)
          .map((s) => cheerio.load(s).text().trim())
          .filter((v) => v.length > 0);

        specs.push({
          sectionTitle,
          name,
          description,
          values: values.length > 0 ? values : [valueText],
        });
      });
    });

    return specs;
  }
}
