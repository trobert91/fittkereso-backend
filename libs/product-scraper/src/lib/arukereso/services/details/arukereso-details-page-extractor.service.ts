import { Injectable } from "@nestjs/common";
import {
  ProductSourceType,
  ScrapeTask,
  SourceSpecConfig,
  SourceSpecMapping,
  SpecExtractMode,
} from "@ebike-backend/database";
import {
  CategoryConfigService,
  SourceConfigService,
} from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import {
  ScrapedProduct,
  ScrapedProductSpec,
  SpecExtractionService,
} from "@ebike-backend/product";
import { TranslationService } from "@ebike-backend/translation";
import * as cheerio from "cheerio";
import { uniq, uniqBy } from "lodash";
import { ArukeresoCategoryMapperService } from "./arukereso-category-mapper.service";
import { ProductDetailsPageExtractor } from "../../../product-scraper/interfaces/product-details-page-extractor.interface";
import { ProductScrapingMetricsService } from "@ebike-backend/metrics";

/**
 * Extract modes that produce a number or structured numeric output. Values fed
 * into these modes don't benefit from translation — the number is parsed out of
 * the raw Hungarian string directly (e.g. "99 g" → 99, "12000 dpi" → 12000).
 */
const NUMERIC_EXTRACT_MODES: ReadonlySet<SpecExtractMode> =
  new Set<SpecExtractMode>([
    "number",
    "secondNumber",
    "roundedNumber",
    "ceiledNumber",
    "cmToInchList",
    "mmToCmAndInchList",
    "standardRatio",
  ]);

@Injectable()
export class ArukeresoDetailsPageExtractor implements ProductDetailsPageExtractor {
  private readonly logger = new CustomLogger(
    ArukeresoDetailsPageExtractor.name,
  );

  constructor(
    private readonly categoryMapper: ArukeresoCategoryMapperService,
    private readonly translationService: TranslationService,
    private readonly specExtraction: SpecExtractionService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly sourceConfigService: SourceConfigService,
    private readonly scrapingMetrics: ProductScrapingMetricsService,
  ) {}

  public async extractProductDetails(
    task: ScrapeTask,
    $: cheerio.CheerioAPI,
  ): Promise<ScrapedProduct | null> {
    const categoryName = this.extractCategory($);
    const extractedSpecs = this.extractSpecifications($);
    const category = await this.categoryMapper.getCategory({
      breadcrumbCategory: categoryName,
      specs: extractedSpecs,
    });
    if (!category) {
      this.logger.warn(
        "Category could not be identified, skipping product creation",
        {
          taskId: task.id,
          url: task.url,
          categoryName,
        },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        ProductSourceType.arukereso,
        "category_not_identified",
      );

      throw new Error("Category could not be identified");
    }

    const enabledCategories = this.sourceConfigService.getEnabledCategorySlugs(
      ProductSourceType.arukereso,
    );
    if (!enabledCategories.includes(category.slug)) {
      this.logger.debug(
        `Skipping product — category '${category.slug}' not enabled for arukereso`,
        { taskId: task.id, url: task.url },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        ProductSourceType.arukereso,
        "category_not_enabled",
      );
      return null;
    }

    const jsonSchema = category.slug
      ? this.categoryConfigService.getJsonSchema(category.slug)
      : undefined;

    if (!jsonSchema) {
      this.logger.warn(
        "Category has no associated JSON schema, skipping product creation",
        {
          taskId: task.id,
          url: task.url,
          categoryName,
        },
      );
      this.scrapingMetrics.recordExtractionSkipReason(
        ProductSourceType.arukereso,
        "missing_schema",
      );

      throw new Error("Category has no associated JSON schema");
    }

    // Find the main product info block
    const productTop = $(".product-page-top");

    // Extract brand and model from the dataLayer JSON injected by arukereso — it
    // contains clean values (e.g. item_brand="ASUS", item_name="ASUS ROG Swift PG34WCDM")
    // without the category suffix that pollutes the breadcrumb and h1 text.
    const dataLayerJson = $("script")
      .toArray()
      .map((el) => $(el).html() ?? "")
      .find((text) => text.includes("dataLayerHG"));
    const dataLayerBrand = dataLayerJson
      ?.match(/"item_brand"\s*:\s*"([^"]+)"/)?.[1]
      ?.trim();
    const dataLayerModel = dataLayerJson
      ?.match(/"item_name"\s*:\s*"([^"]+)"/)?.[1]
      ?.trim();

    // Fall back to breadcrumb for brand if dataLayer is unavailable.
    // The breadcrumb position 4 (index 3) contains "<Brand> <CategoryName>" e.g. "Logitech Billentyűzet"
    // so we strip the category word(s) to isolate the brand name.
    const breadcrumbBrandText = $(
      '.breadcrumb-field [itemprop="itemListElement"]',
    )
      .eq(3)
      .find('[itemprop="name"]')
      .text()
      .trim();
    const breadcrumbBrand = breadcrumbBrandText
      .replace(new RegExp(`\\s*${categoryName}\\s*`, "i"), "")
      .trim();
    const brand = dataLayerBrand || breadcrumbBrand;

    // Fall back to h1 text for model if dataLayer is unavailable.
    // Both sources include the brand prefix (e.g. "ASUS ROG Swift PG34WCDM"), so strip it.
    const h1Text = productTop.find("h1.hidden-xs").first().text().trim();
    const fullModelText = dataLayerModel ?? h1Text;
    const rawModel = brand
      ? fullModelText.replace(new RegExp(`^${brand}\\s*`), "")
      : fullModelText;

    // Strip parenthesized SKU / color-variant codes from the model name
    // (e.g. "Sennheiser Momentum 4 (700382/3/6)" → "Sennheiser Momentum 4").
    // These codes aren't product-identifying and are dropped, not saved as aliases.
    const partNumberPattern =
      /\s*\([A-Za-z0-9][A-Za-z0-9\-/]*(?:-[A-Za-z0-9]+|[0-9])[A-Za-z0-9\-/]*\)/g;
    const modelWithoutPartNumbers = rawModel
      .replace(partNumberPattern, "")
      .trim();
    const model = modelWithoutPartNumbers
      .replace(
        /\s+\b(AF|AR|BE|BR|CA|CH|CZ|DE|DK|EE|ES|FI|FR|GB|GR|HR|HU|IL|IT|JP|KR|LA|LT|LV|ME|MK|NL|NO|PL|PT|RO|RS|RU|SE|SI|SK|SL|TR|UA|UK|US|YU)\b\s*$/i,
        "",
      )
      .trim();
    const displayName = `${brand} ${model}`.trim();

    const sourceConfig = category.slug
      ? this.categoryConfigService.getSpecMappingsForSource(
          category.slug,
          ProductSourceType.arukereso,
        )
      : undefined;

    // Pre-translate spec values for this product in a single batched call.
    // Only values that actually feed into a string-producing mapping are sent —
    // numeric specs (e.g. weight, dpi, buttons) have their numbers parsed out
    // of the raw Hungarian string by the extract mode and don't need translation,
    // and unmapped spec labels never reach the final ProductSpecs anyway.
    // Category name is included in the context so the LLM can disambiguate terms
    // that mean different things across categories (e.g. "optikai" = "optical"
    // for mice sensors vs "optical" for headphone connection types).
    const rawValues = this.collectTranslatableValues(
      extractedSpecs,
      sourceConfig,
    );
    const translationContext = `Technical specification values from an arukereso.hu product listing in the "${category.name}" category. Preserve units, model numbers, and technical jargon.`;
    const { lookup: translator, stats: translationStats } =
      await this.translationService.translateBatch({
        texts: rawValues,
        sourceLanguage: "hu",
        targetLanguage: "en",
        context: translationContext,
      });

    this.logger.debug("Arukereso spec translation completed", {
      url: task.url,
      ...translationStats,
    });

    const specs = sourceConfig
      ? this.specExtraction.extractSpecs({
          scrapedSpecs: extractedSpecs,
          schema: jsonSchema,
          sourceConfig,
          translator,
        })
      : {};

    const allImageUrls = this.extractImageUrls($);
    const mainImageUrl = allImageUrls[0];

    return {
      brand,
      displayName,
      model,
      category,
      specs,
      imageUrls: mainImageUrl ? [mainImageUrl] : [],
    };
  }

  /**
   * Collect raw spec values that actually benefit from translation. Skips:
   *   - Specs whose label is not referenced by any mapping (they never make it
   *     into the final ProductSpecs, so translating is pure waste)
   *   - Specs whose mapping uses a numeric extract mode (number, secondNumber,
   *     cmToInchList, etc.) — the number is parsed from the raw Hungarian
   *     string directly, translation adds nothing and wastes LLM budget
   *   - Values covered by the mapping's `valueMap` — those are resolved
   *     deterministically at extract time and bypass translation entirely
   */
  private collectTranslatableValues(
    extractedSpecs: ScrapedProductSpec[],
    sourceConfig: SourceSpecConfig | undefined,
  ): string[] {
    if (!sourceConfig) return [];

    // Build a case-insensitive map from label → mapping for string-producing mappings
    const mappingsByLabel = new Map<string, SourceSpecMapping>();
    for (const mapping of sourceConfig.mappings) {
      if (mapping.extract && NUMERIC_EXTRACT_MODES.has(mapping.extract))
        continue;
      for (const label of mapping.labels) {
        mappingsByLabel.set(label.toLowerCase(), mapping);
      }
    }

    const values: string[] = [];
    for (const spec of extractedSpecs) {
      const mapping = mappingsByLabel.get(spec.name.toLowerCase());
      if (!mapping) continue;
      if (!spec.values) continue;

      const valueMapKeys = mapping.valueMap
        ? new Set(Object.keys(mapping.valueMap).map((key) => key.toLowerCase()))
        : undefined;

      for (const value of spec.values) {
        if (!value) continue;
        if (valueMapKeys && valueMapKeys.has(value.toLowerCase())) continue;
        values.push(value);
      }
    }
    return values;
  }

  private extractImageUrls($: cheerio.CheerioAPI): string[] {
    const urls: string[] = [];

    // V1 layout: carousel with lazy-loaded images
    $(".carousel-inner img").each((_, el) => {
      const src = $(el).attr("data-lazy-delayed-src");
      if (src) {
        urls.push(src.trim());
      }
    });

    // V2 layout: collect image URLs, preferring full-size from href over mid-size from src
    if (urls.length === 0) {
      $(".product-image").each((_, el) => {
        const href = $(el).find("a.product-image-wrapper").attr("href");
        if (href && href.includes("akcdn.net")) {
          urls.push(href.trim());
          return;
        }

        const src = $(el).find("img").attr("src");
        if (src && src.includes("akcdn.net")) {
          urls.push(src.replace("/mid/", "/full/").trim());
        }
      });
    }

    return uniq(urls);
  }

  /**
   * Determine category by checking for known TV-related section titles
   */
  private extractCategory($: cheerio.CheerioAPI): string {
    // Find all breadcrumb items
    const breadcrumbItems = $('.breadcrumb-field [itemprop="itemListElement"]');

    // The third element (position = 2) should contain the category
    const thirdItem = breadcrumbItems.eq(2);
    const category = thirdItem.find('[itemprop="name"]').text().trim();

    return category || "unknown";
  }

  private extractSpecifications($: cheerio.CheerioAPI): ScrapedProductSpec[] {
    const specs =
      $("table.product-properties").length > 0
        ? this.extractSpecificationsV1($)
        : this.extractSpecificationsV2($);

    const description = this.extractDescription($);
    if (description) {
      specs.push({ name: "description", values: [description] });
    }

    return specs;
  }

  private extractDescription($: cheerio.CheerioAPI): string | undefined {
    return (
      $('meta[itemprop="description"]').first().attr("content")?.trim() ||
      undefined
    );
  }

  private extractSpecificationsV1($: cheerio.CheerioAPI): ScrapedProductSpec[] {
    const specs: ScrapedProductSpec[] = [];
    let currentSection: string | undefined;

    $("table.product-properties tr").each((_, tr) => {
      const $tr = $(tr);
      const nameCell = $tr.find("td.prop-name");
      const valueCell = $tr.find("td").eq(1);

      if (!nameCell.length) return;

      // Detect <h3> — this marks a new section
      const h3 = nameCell.find("h3");
      if (h3.length > 0) {
        currentSection = h3.text().trim();
        return;
      }

      const name = nameCell.clone().children().remove().end().text().trim();
      if (!name) return;

      // Extract hint description if present
      const description = nameCell.find(".hint").attr("data-content")?.trim();

      // Extract values (handle <div class="prop"><div class="name">...</div></div>)
      const values: string[] = [];

      if (valueCell.find(".prop .name").length > 0) {
        valueCell.find(".prop .name").each((_, el) => {
          const val = $(el).text().trim();
          if (val) values.push(val);
        });
      } else {
        const text = valueCell.text().trim();
        if (text) values.push(text);
      }

      specs.push({
        sectionTitle: currentSection,
        name,
        description,
        values,
      });
    });

    return uniqBy(specs, (spec) => spec.name);
  }

  /**
   * Extract structured specs grouped by section headers
   */
  private extractSpecificationsV2($: cheerio.CheerioAPI): ScrapedProductSpec[] {
    const specs: ScrapedProductSpec[] = [];
    let currentSectionTitle: string | undefined = undefined;

    $("table.property-sheet tr").each((_, el) => {
      const $row = $(el);

      // Section header row
      if ($row.hasClass("property-title")) {
        currentSectionTitle = $row.text().trim();
        return;
      }

      const name = $row.find(".property-name").text().trim();
      const description = $row
        .find(".icon-help-circled")
        .attr("data-content")
        ?.trim();

      const values: string[] = [];

      // Extract visible text values
      $row.find(".property-value div").each((_, div) => {
        const text = $(div).text().trim();
        if (text) {
          values.push(text);
        } else {
          // For icon-ok / icon-cancel (Yes/No)
          const icon = $(div).find(".icon-ok, .icon-cancel").first();
          const title = icon.attr("title");
          if (title) values.push(title.trim());
        }
      });

      if (name) {
        specs.push({
          name,
          sectionTitle: currentSectionTitle,
          description,
          values: values.length ? values : undefined,
        });
      }
    });

    return uniqBy(specs, (spec) => spec.name);
  }
}
