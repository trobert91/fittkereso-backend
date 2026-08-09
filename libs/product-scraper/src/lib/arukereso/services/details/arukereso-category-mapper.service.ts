import { Injectable } from "@nestjs/common";
import {
  ProductCategory,
  ProductCategoryRepository,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { ScrapedProductSpec } from "@ebike-backend/product";

export interface GetCategoryInput {
  breadcrumbCategory: string;
  specs: ScrapedProductSpec[];
}

@Injectable()
export class ArukeresoCategoryMapperService {
  private readonly logger = new CustomLogger(
    ArukeresoCategoryMapperService.name,
  );

  constructor(private readonly categoryRepo: ProductCategoryRepository) {}

  public async getCategory({
    breadcrumbCategory,
    specs,
  }: GetCategoryInput): Promise<ProductCategory | null> {
    switch (breadcrumbCategory.toLowerCase()) {
      case "monitor":
        return this.getCategoryBySlug("monitors");
      case "sportkamera":
        return this.getCategoryBySlug("action-cameras");
      case "hordozható hangszóró":
        return this.getCategoryBySlug("portable-bluetooth-speakers");
      case "ip kamera":
        return this.getCategoryBySlug("ip-cameras");
      case "fülhallgató, fejhallgató":
        // Árukereső lumps earbuds, over-ear headphones, and gaming headsets
        // under a single breadcrumb. Default to Headphones; only route to
        // Headsets when the "Típus" spec explicitly says "headset" or "gamer".
        return this.resolveHeadphonesOrHeadsets(specs);
      case "billentyűzet":
        return this.getCategoryBySlug("keyboards");
      case "egér":
        return this.getCategoryBySlug("mice");
      case "projektor":
        return this.getCategoryBySlug("projectors");
      case "takarító robot":
        return this.getCategoryBySlug("robot-vacuums");
      case "okosóra, aktivitásmérő":
        return this.getCategoryBySlug("smartwatches-fitness-trackers");
      case "hangprojektor":
        return this.getCategoryBySlug("soundbars");
      case "belső ssd meghajtó":
        return this.getCategoryBySlug("internal-ssds");
      case "led tv, lcd tv, oled tv":
        return this.getCategoryBySlug("tvs");
      case "router":
        return this.getCategoryBySlug("wifi-routers");
    }

    return null;
  }

  private async resolveHeadphonesOrHeadsets(
    specs: ScrapedProductSpec[],
  ): Promise<ProductCategory | null> {
    const tipus =
      specs
        .find((spec) => spec.name.toLowerCase() === "típus")
        ?.values?.join(" ")
        .toLowerCase() ?? "";

    if (
      tipus.includes("fülhallgató") ||
      tipus.includes("fül mögé helyezhető")
    ) {
      return this.getCategoryBySlug("headphones");
    }
    return this.getCategoryBySlug("headsets");
  }

  private async getCategoryBySlug(
    slug: string,
  ): Promise<ProductCategory | null> {
    return this.categoryRepo.findBySlug(slug);
  }
}
