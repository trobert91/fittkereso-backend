import { Injectable } from "@nestjs/common";
import {
  ProductCategory,
  ProductCategoryRepository,
} from "@ebike-backend/database";
import { ScrapedProductSpec } from "@ebike-backend/product";
import { compact } from "lodash";

@Injectable()
export class DisplayspecsCategoryMapperService {
  private _tvCategory: ProductCategory | null = null;
  private _monitorCategory: ProductCategory | null = null;

  constructor(private readonly categoryRepo: ProductCategoryRepository) {}

  public async getCategory(
    specs: ScrapedProductSpec[],
  ): Promise<ProductCategory> {
    // Section titles that indicate a TV
    const tvSections = ["Video file formats", "Audio file formats", "TV tuner"];

    // Normalize section titles for comparison
    const sectionTitles = compact(
      specs.map((s) => s.sectionTitle?.toLowerCase().trim()),
    );

    const isTV = sectionTitles.some((title) =>
      tvSections.some((tvTitle) => title === tvTitle.toLowerCase()),
    );

    if (isTV) {
      return this.getTVCategory();
    }

    return this.getMonitorCategory();
  }

  private async getTVCategory(): Promise<ProductCategory> {
    if (this._tvCategory) return this._tvCategory;
    this._tvCategory = await this.categoryRepo.findBySlug("tvs");
    if (!this._tvCategory) {
      throw new Error("TV category not found in database");
    }

    return this._tvCategory;
  }

  private async getMonitorCategory(): Promise<ProductCategory> {
    if (this._monitorCategory) return this._monitorCategory;
    this._monitorCategory = await this.categoryRepo.findBySlug("monitors");
    if (!this._monitorCategory) {
      throw new Error("Monitor category not found in database");
    }

    return this._monitorCategory;
  }
}
